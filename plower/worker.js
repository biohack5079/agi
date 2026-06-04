import { pipeline, env, RawImage, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// このWorkerファイルは、HTML/UI層とは完全に隔離された「AIカプセル」として動作します。
// WebGPUが使えない環境（Linuxの一部や未対応ブラウザ）では、自動的にCPU(WASM)にフォールバックします。

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useOriginPrivateFileSystem = true;
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
                const progressStr = (typeof x.progress === 'number' && !isNaN(x.progress)) ? ` (${Math.round(x.progress)}%)` : '';
                postMessage({ status: 'loading', output: `モデル読込中(キャッシュ優先): ${x.file}${progressStr}` });
            } else if (x.status === 'init') {
                postMessage({ status: 'loading', output: `モデル構築中...` });
            }
        }
    });
    return generatorPromise;
}

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

self.onmessage = async (e) => {
    const { type, prompt, image } = e.data;

    if (type === 'generate') {
        try {
            let currentDevice = await checkDevice();
            
            // 画像があり、ユーザーが実行を希望している場合はVLMを使用。
            // CPU(WASM)環境では非常に低速ですが、ユーザーの要望により制限を解除します。
            let useVision = !!image;
            const modelId = useVision
                ? 'onnx-community/Qwen2-VL-2B-Instruct'
                : (currentDevice === 'wasm' ? 'onnx-community/Qwen2.5-0.5B-Instruct' : 'onnx-community/Llama-3.2-1B-Instruct');

            let warningPrefix = "";
            if (image && currentDevice === 'wasm') {
                warningPrefix = "⚠️ WebGPUがオフ（または未対応）のため、CPU(WASM)で画像解析を実行します。完了まで非常に時間がかかる可能性があります。\n\n";
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
                useVision = false;
                warningPrefix = "⚠️ 大きなモデルのロードに失敗した（またはメモリ不足の）ため、軽量Qwen(0.5B)にフォールバックしました。画像は無視されます。\n\n" + warningPrefix;
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
                            { type: "text", text: prompt + "\n(指示: Gemini APIのように、必ず日本語で簡潔に要点のみを回答してください。長文は避けてください。)" }
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
                    { role: "system", content: "あなたは役に立つアシスタントです。必ず日本語で、Gemini APIのように非常に簡潔に要点のみを回答してください。長文は避けてください。" },
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
            const isTinyFallback = generator.modelId === 'onnx-community/Qwen2.5-0.5B-Instruct';
            let maxNewTokens = 1024;
            
            if (isTinyFallback) {
                // 入力が長すぎるとメモリ不足になるため、入力側のみ安全策をとる
                const promptText = typeof inputs === 'string' ? inputs : prompt;
                if (promptText.length > 2000) {
                    inputs = promptText.slice(0, 2000);
                    console.warn(`Input truncated to 2000 chars`);
                }
            } else {
                maxNewTokens = 1024;
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
                postMessage({ status: 'chunk', output: generatedText + `\n⏳ CPU推論開始 (1024トークンを使用予定、じっくり推論します)...`, tokenCount: 0, elapsed: '0', maxTokens: maxNewTokens });
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
                const safeOutput = '[ignoring loop detection]\n' + prompt;
                postMessage({ status: 'complete', output: safeOutput.trim() });
            } else {
                postMessage({ status: 'error', error: error.toString() });
            }
        }

    }
};
