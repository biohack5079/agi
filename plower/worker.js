import { pipeline, env, RawImage, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// このWorkerファイルは、HTML/UI層とは完全に隔離された「AIカプセル」として動作します。
// WebGPUが使えない環境（Linuxの一部や未対応ブラウザ）では、自動的にCPU(WASM)にフォールバックします。

env.allowLocalModels = false;
env.useBrowserCache = false; // OPFSを使用するため通常のCache APIはオフにする
env.useOriginPrivateFileSystem = true; // Origin Private File System を有効化

// CPU(WASM)で動かす場合のスレッド数を最適化
env.backends.onnx.wasm.numThreads = 1; // single-threaded to work without crossOriginIsolated

// CPU推論のタイムアウト (90秒 — GPT-2 WASMは1トークン≒1-2秒かかるため)
const CPU_INFERENCE_TIMEOUT_MS = 6000000;

let generatorPromise = null;
let currentGeneratorModelId = null;

async function initGenerator(task, modelId, device, token) {
    if (currentGeneratorModelId === modelId && generatorPromise) {
        return generatorPromise;
    }
    
    // 新しいモデルを読み込む際、古いリソースを明示的に解放する
    currentGeneratorModelId = null;
    generatorPromise = null;

    // 別のモデルをロード済みの場合は、WASMメモリ解放のため可能であれば破棄(dispose)する
    if (generatorPromise) {
        try {
            const oldGen = await generatorPromise;
            if (typeof oldGen.dispose === 'function') oldGen.dispose();
        } catch(e) {}
    }
    
    currentGeneratorModelId = modelId;
    
    const pipelineOptions = {
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

    // トークンが有効な文字列の場合のみ設定（nullやundefinedを渡すと401エラーになるのを防ぐ）
    if (token && typeof token === 'string' && token !== 'null' && token !== 'undefined') {
        pipelineOptions.token = token;
    }

    generatorPromise = pipeline(task, modelId, pipelineOptions);
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

self.onmessage = async (e) => {
    const { type, prompt, image, model, useOPFS, token } = e.data;

    if (type === 'generate') {
        try {
            let currentDevice = await checkDevice();
            
            // 指定されたモデルIDを使用
            const modelId = model || 'onnx-community/moondream2';
            
            // 画像入力の有無に関わらず text-generation タスクで動作します
            const task = 'text-generation';
            let useVision = !!image; 

            let warningPrefix = "";
            if (useVision && currentDevice === 'wasm') {
                warningPrefix = "⚠️ WebGPUがオフ（または未対応）のため、CPU(WASM)で画像解析を実行します。完了まで非常に時間がかかる可能性があります。\n\n";
            } else if (currentDevice === 'wasm') {
                warningPrefix = "⚠️ WebGPUが未対応のため、CPU(WASM)で実行します。推論に時間がかかります。\n\n";
            }

            postMessage({ status: 'loading', output: `OSSモデル初期化中... (エンジン: ${currentDevice.toUpperCase()})` });
            let generator = await initGenerator(task, modelId, currentDevice, token);
            generator.modelId = modelId;

            postMessage({ status: 'loading', output: `推論中... (${currentDevice.toUpperCase()})` });

            // メッセージフォーマット
            let inputs;
            const messages = [
                { role: "system", content: "あなたは役に立つアシスタントです。必ず日本語で、簡潔に要点のみを回答してください。" },
                {
                    role: "user",
                    content: useVision 
                        ? [{ type: "image" }, { type: "text", text: prompt }]
                        : [{ type: "text", text: prompt }]
                }
            ];

            if (useVision) {
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
                inputs = { text: formattedPrompt, images: [rawImg] };
            } else {
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
            const maxNewTokens = 1024;

            if (currentDevice === 'wasm') {
                // CPU実行時はメモリ不足によるクラッシュを防ぐため、入力を約2000文字に制限
                if (typeof inputs === 'string' && inputs.length > 2000) {
                    inputs = inputs.slice(0, 2000);
                } else if (inputs && typeof inputs.text === 'string' && inputs.text.length > 2000) {
                    // 画像(Vision)入力時のテキスト部分も制限
                    inputs.text = inputs.text.slice(0, 2000);
                }
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
            if (currentDevice === 'wasm') {
                postMessage({ status: 'chunk', output: generatedText + `\n⏳ CPU推論開始 (1024トークンを使用予定、じっくり推論します)...`, tokenCount: 0, elapsed: '0', maxTokens: maxNewTokens });
            }

            // Run inference – タイムアウト付き
            // CPU (WASM) は非常に遅いため、タイムアウトを設けてフリーズを防ぐ
            const inferencePromise = (async () => {
                try {
                    // 推論を実行
                    await generator(inputs, { 
                        max_new_tokens: maxNewTokens, 
                        temperature: 0.1, 
                        do_sample: false, 
                        streamer, 
                        repetition_penalty: 1.2 
                    });
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
