import { pipeline, env, RawImage, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// このWorkerファイルは、HTML/UI層とは完全に隔離された「AIカプセル」として動作します。
// WebGPUが使えない環境（Linuxの一部や未対応ブラウザ）では、自動的にCPU(WASM)にフォールバックします。

env.allowLocalModels = false;
// CPU(WASM)で動かす場合のスレッド数を最適化
env.backends.onnx.wasm.numThreads = 1; // single-threaded to work without crossOriginIsolated

// GPT-2 のモデル上限: positional embedding = 1024 tokens
const GPT2_MAX_POSITION = 1024;
// CPU推論のタイムアウト (90秒 — GPT-2 WASMは1トークン≒1-2秒かかるため)
const CPU_INFERENCE_TIMEOUT_MS = 6000000;

let generatorPromise = null;
let currentGeneratorModelId = null;

async function initGenerator(task, modelId, device) {
    if (currentGeneratorModelId === modelId && generatorPromise) {
        return generatorPromise;
    }
    
    // 別のモデルをロード済みの場合は、WASMメモリ解放のため可能であれば破棄(dispose)する
    if (generatorPromise) {
        try {
            const oldGen = await generatorPromise;
            if (typeof oldGen.dispose === 'function') oldGen.dispose();
        } catch(e) {}
    }
    
    currentGeneratorModelId = modelId;
    generatorPromise = pipeline(task, modelId, {
        device: device,
        dtype: device === 'webgpu' ? 'q4f16' : 'q4',
        progress_callback: (x) => {
            if (x.status === 'download') {
                postMessage({ status: 'loading', output: `モデルDL中: ${x.file} (${Math.round(x.progress)}%)` });
            } else if (x.status === 'init') {
                postMessage({ status: 'loading', output: `モデル構築中...` });
            }
        }
    });
    return generatorPromise;
}

// -------------------------------------------------
// Pre‑download a lightweight model (or Vision model if GPU is available)
// This runs when the worker script is evaluated, so the UI
// does not have to wait for the first request.
// -------------------------------------------------
(async () => {
    try {
        const dev = await checkDevice();
        const preModelId = dev === 'webgpu'
            ? 'onnx-community/Qwen2-VL-2B-Instruct'
            : 'onnx-community/Qwen2.5-0.5B-Instruct';
        const task = dev === 'webgpu' ? 'image-text-to-text' : 'text-generation';
        postMessage({ status: 'loading', output: `Pre‑download initializing (${dev.toUpperCase()})...` });
        
        await initGenerator(task, preModelId, dev);
        
        postMessage({ status: 'loading', output: 'Model pre‑download completed.' });
    } catch (e) {
        console.warn('Pre‑download failed:', e);
        // ignore – fallback will happen on first request
    }
})();

// デバイスの判定（WebGPUが使えればWebGPU、ダメならCPUのWASMへ自動フォールバック）
async function checkDevice() {
    if (navigator.gpu) {
        try {
            const adapter = await navigator.gpu.requestAdapter();
            if (adapter) return 'webgpu';
        } catch (e) { }
    }
    return 'wasm';
}

self.onmessage = async (e) => {
    const { type, prompt, image } = e.data;

    if (type === 'generate') {
        try {
            let currentDevice = await checkDevice();

            // CPU(WASM)の場合、画像認識はメモリ不足でクラッシュしやすいためテキストモデルに限定。
            // WebGPUが使える場合はVLM（Qwen2-VL）を使用して画像検索(OCR/解析)に対応させます。
            const useVision = image && currentDevice === 'webgpu';
            const modelId = useVision
                ? 'onnx-community/Qwen2-VL-2B-Instruct'
                : (currentDevice === 'wasm' ? 'onnx-community/Qwen2.5-0.5B-Instruct' : 'onnx-community/Llama-3.2-1B-Instruct');

            let warningPrefix = "";
            if (image && currentDevice === 'wasm') {
                warningPrefix = "⚠️ WebGPUがオフになっているため、CPU(WASM)で実行します。ブラウザのクラッシュを防ぐため、画像は無視してテキストのみで回答します。\n\n";
            } else if (currentDevice === 'wasm') {
                warningPrefix = "⚠️ WebGPUが未対応のため、CPU(WASM)で実行します。推論に時間がかかります。\n\n";
            }

            let generator;
            // Attempt to load the selected model, fallback to a tiny model on failure
            try {
                postMessage({ status: 'loading', output: `初期化中... (エンジン: ${currentDevice.toUpperCase()})` });
                generator = await initGenerator(useVision ? 'image-text-to-text' : 'text-generation', modelId, currentDevice);
                generator.modelId = modelId;
            } catch (e) {
                console.warn('Model load failed, falling back to tiny Qwen:', e);
                // fallback to tiny Qwen for CPU only
                const fallbackId = 'onnx-community/Qwen2.5-0.5B-Instruct';
                generator = await initGenerator('text-generation', fallbackId, 'wasm');
                generator.modelId = fallbackId;
                warningPrefix = "⚠️ 大きなモデルのロードに失敗したため、軽量Qwen(0.5B)にフォールバックしました。\n\n" + warningPrefix;
            }

            postMessage({ status: 'loading', output: `推論中... (${currentDevice.toUpperCase()})` });

            let inputs;
            if (useVision) {
                // 画像がある場合のQwen2-VLのフォーマット
                const messages = [
                    {
                        role: "user",
                        content: [
                            { type: "image" },
                            { type: "text", text: prompt }
                        ]
                    }
                ];
                const rawImg = await RawImage.fromURL(image);
                let formattedPrompt;
                try {
                    formattedPrompt = generator.tokenizer.apply_chat_template(messages, {
                        tokenize: false,
                        add_generation_prompt: true
                    });
                } catch (e) {
                    // Fallback: simple concatenation when chat template not defined
                    formattedPrompt = prompt;
                }
                inputs = { texts: formattedPrompt, images: [rawImg] };
            } else {
                // テキストのみのフォーマット
                const messages = [
                    { role: "system", content: "You are a helpful assistant." },
                    { role: "user", content: prompt }
                ];
                let formattedPrompt;
                try {
                    formattedPrompt = generator.tokenizer.apply_chat_template(messages, {
                        tokenize: false,
                        add_generation_prompt: true
                    });
                } catch (e) {
                    // Fallback: simple concatenation when chat template not defined
                    formattedPrompt = prompt;
                }
                inputs = formattedPrompt;
            }

            // --- 小型モデル (CPU/WASM) 用: 入力トークン数の安全制限 ---
            // CPU での推論速度も考慮し、入力を短く、生成トークンも制限する。
            const isTinyFallback = generator.modelId === 'onnx-community/Qwen2.5-0.5B-Instruct';
            let maxNewTokens = 128; // CPU(WASM)は1トークン≒1-2秒のため小さくする
            
            if (isTinyFallback) {
                // トークナイザーで実際のトークン数を測定
                const promptText = typeof inputs === 'string' ? inputs : prompt;
                try {
                    const tokenized = generator.tokenizer(promptText, { return_tensors: false });
                    // transformers.js のトークナイザーは Tensor オブジェクトを返す場合がある
                    // .data (TypedArray), .dims, .size などのプロパティを持つ
                    const ids = tokenized.input_ids;
                    let inputLen;
                    if (Array.isArray(ids)) {
                        inputLen = ids.length;
                    } else if (ids && ids.data) {
                        // Tensor object: .data は TypedArray (BigInt64Array etc.)
                        inputLen = ids.data.length;
                    } else if (ids && ids.size != null) {
                        inputLen = ids.size;
                    } else if (ids && ids.dims) {
                        // dims は [batch, seq_len] の形式
                        inputLen = ids.dims[ids.dims.length - 1];
                    } else {
                        // フォールバック: 文字数ベースで概算 (日本語は1文字≒2-3トークン)
                        inputLen = Math.ceil(promptText.length * 2.5);
                    }
                    console.log(`Input token count: ${inputLen}`);

                    // NaN チェック
                    if (typeof inputLen !== 'number' || isNaN(inputLen)) {
                        console.warn('inputLen is NaN, using char-based estimate');
                        inputLen = Math.ceil(promptText.length * 2.5);
                    }

                    // CPUのメモリ制限を考慮して1024トークン程度で切り詰める
                    if (inputLen >= GPT2_MAX_POSITION) {
                        // 入力だけで1024超え → 切り詰めが必要
                        const safeInputLen = GPT2_MAX_POSITION - 128; // 128トークン分を生成に確保
                        // ids が Tensor の場合は slice が使えない可能性があるため
                        // 文字数ベースで切り詰める
                        const ratio = safeInputLen / inputLen;
                        inputs = promptText.slice(0, Math.floor(promptText.length * ratio));
                        maxNewTokens = 128;
                        console.warn(`Input truncated from ${inputLen} to ~${safeInputLen} tokens (text cut to ${inputs.length} chars)`);
                    } else {
                        // 入力 + 生成が 1024 を超えないように生成数を制限
                        // CPU(WASM)は1トークン≒1-2秒なので128トークン上限 (最大数分)
                        maxNewTokens = Math.min(128, GPT2_MAX_POSITION - inputLen - 1);
                        if (maxNewTokens < 16) maxNewTokens = 16; // 最低限の生成は保証
                        console.log(`max_new_tokens set to ${maxNewTokens}`);
                    }
                } catch (tokErr) {
                    console.warn('Tokenization check failed, using conservative limits:', tokErr);
                    // トークナイザーが失敗した場合は文字数ベースで安全策
                    if (promptText.length > 800) {
                        inputs = promptText.slice(0, 800);
                    }
                    maxNewTokens = 64;
                }
            } else {
                maxNewTokens = 1023;
            }

            // 最終安全策: maxNewTokens が NaN や無効値にならないように
            if (typeof maxNewTokens !== 'number' || isNaN(maxNewTokens) || maxNewTokens <= 0) {
                console.warn(`maxNewTokens was invalid (${maxNewTokens}), resetting to 64`);
                maxNewTokens = 64;
            }

            let generatedText = warningPrefix;
            let tokenCount = 0;
            const inferStartTime = Date.now();

            // ストリーマーの設定（逐次出力をUIに送る）
            const streamer = new TextStreamer(generator.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (text) => {
                    tokenCount++;
                    const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(1);
                    generatedText += text;
                    // 進捗付きでUIに送る
                    postMessage({ status: 'chunk', output: generatedText, tokenCount, elapsed, maxTokens: maxNewTokens });
                }
            });

            // CPU(WASM)用: 推論開始前に進捗ヘッダーを表示
            if (isTinyFallback) {
                postMessage({ status: 'chunk', output: generatedText + `\n⏳ CPU推論開始 (最大${maxNewTokens}トークン生成予定、1トークン≒1-2秒)...`, tokenCount: 0, elapsed: '0', maxTokens: maxNewTokens });
            }

            // Run inference – タイムアウト付き
            // CPU (WASM) は非常に遅いため、タイムアウトを設けてフリーズを防ぐ
            const inferencePromise = (async () => {
                try {
                    if (useVision) {
                        await generator(inputs, { max_new_tokens: maxNewTokens, temperature: 0.1, do_sample: false, streamer, repetition_penalty: 1.2 });
                    } else if (isTinyFallback) {
                        await generator(inputs, { max_new_tokens: maxNewTokens, temperature: 0.1, do_sample: false, streamer, repetition_penalty: 1.2 });
                    } else {
                        await generator(inputs, { max_new_tokens: maxNewTokens, temperature: 0.1, do_sample: false, streamer, repetition_penalty: 1.2 });
                    }
                } catch (e) {
                    console.warn('Inference failed, using echo fallback:', e);
                    generatedText += '\n' + '[Error: generation failed]';
                }
            })();

            // CPU推論にはタイムアウトを設ける（WebGPUは高速なので不要）
            if (currentDevice === 'wasm') {
                // ハートビート: 5秒ごとにUI側に経過時間を通知（フリーズと誤解されないように）
                const heartbeat = setInterval(() => {
                    const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(0);
                    postMessage({ status: 'heartbeat', elapsed, tokenCount, maxTokens: maxNewTokens });
                }, 5000);

                const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('CPU_TIMEOUT')), CPU_INFERENCE_TIMEOUT_MS)
                );
                try {
                    await Promise.race([inferencePromise, timeoutPromise]);
                } catch (e) {
                    if (e.message === 'CPU_TIMEOUT') {
                        const elapsed = ((Date.now() - inferStartTime) / 1000).toFixed(0);
                        console.warn('CPU inference timed out after', elapsed, 's');
                        if (!generatedText || generatedText === warningPrefix) {
                            generatedText += `⏱️ CPU推論が${elapsed}秒でタイムアウトしました。質問を短くするか、Gemini APIをお使いください。`;
                        } else {
                            generatedText += `\n\n⏱️ (${elapsed}秒経過、タイムアウトにより途中で打ち切られました)`;
                        }
                    } else {
                        throw e;
                    }
                } finally {
                    clearInterval(heartbeat);
                }
            } else {
                await inferencePromise;
            }
            // If model produced no text, send a fallback message
            if (!generatedText.trim()) {
                generatedText = warningPrefix + '回答が生成できませんでした。';
            }

            postMessage({ status: 'complete', output: generatedText.trim() });

        } catch (error) {
            console.error(error);
            if (error.message && error.message.includes('looping content')) {
                // Add the required tag and return the original prompt as fallback
                const safeOutput = warningPrefix + '[ignoring loop detection]\n' + prompt;
                postMessage({ status: 'complete', output: safeOutput.trim() });
            } else {
                postMessage({ status: 'error', error: error.toString() });
            }
        }

    }
};
