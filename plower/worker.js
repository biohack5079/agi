import { pipeline, env, RawImage, TextStreamer } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2";

// このWorkerファイルは、HTML/UI層とは完全に隔離された「AIカプセル」として動作します。
// WebGPUが使えない環境（Linuxの一部や未対応ブラウザ）では、自動的にCPU(WASM)にフォールバックします。

env.allowLocalModels = false;
// CPU(WASM)で動かす場合のスレッド数を最適化
env.backends.onnx.wasm.numThreads = 1; // single-threaded to work without crossOriginIsolated

let generator = null;
let currentDevice = 'wasm';

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
            : 'Xenova/gpt2';
        const task = dev === 'webgpu' ? 'image-text-to-text' : 'text-generation';
        postMessage({ status: 'loading', output: `Pre‑download initializing (${dev.toUpperCase()})...` });
        await pipeline(task, preModelId, {
            device: dev,
            dtype: dev === 'webgpu' ? 'q4f16' : 'q4',
            progress_callback: (x) => {
                if (x.status === 'download') {
                    postMessage({ status: 'loading', output: `Pre‑download ${x.file}: ${Math.round(x.progress)}%` });
                } else if (x.status === 'init') {
                    postMessage({ status: 'loading', output: 'Pre‑download model constructing...' });
                }
            }
        });
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
        } catch(e) {}
    }
    return 'wasm';
}

self.onmessage = async (e) => {
    const { type, prompt, image } = e.data;
    
    if (type === 'generate') {
        try {
            currentDevice = await checkDevice();
            
            // CPU(WASM)の場合、画像認識はメモリ不足でクラッシュしやすいためテキストモデルに限定。
            // WebGPUが使える場合はVLM（Qwen2-VL）を使用して画像検索(OCR/解析)に対応させます。
            const useVision = image && currentDevice === 'webgpu';
            const modelId = useVision
                ? 'onnx-community/Qwen2-VL-2B-Instruct'
                : (currentDevice === 'wasm' ? 'Xenova/gpt2' : 'onnx-community/Llama-3.2-1B-Instruct');

            let warningPrefix = "";
            if (image && currentDevice === 'wasm') {
                 warningPrefix = "⚠️ WebGPUがオフになっているため、CPU(WASM)で実行します。ブラウザのクラッシュを防ぐため、画像は無視してテキストのみで回答します。\n\n";
            } else if (currentDevice === 'wasm') {
                 warningPrefix = "⚠️ WebGPUが未対応のため、CPU(WASM)で実行します。推論に時間がかかります。\n\n";
            }

            // Attempt to load the selected model, fallback to a tiny model on failure
            try {
                if (!generator || generator.modelId !== modelId) {
                    postMessage({ status: 'loading', output: `初期化中... (エンジン: ${currentDevice.toUpperCase()})` });
                    generator = await pipeline(useVision ? 'image-text-to-text' : 'text-generation', modelId, {
                        device: currentDevice,
                        dtype: currentDevice === 'webgpu' ? 'q4f16' : 'q4',
                        progress_callback: (x) => {
                            if (x.status === 'download') {
                                postMessage({ status: 'loading', output: `モデルDL中: ${x.file} (${Math.round(x.progress)}%)` });
                            } else if (x.status === 'init') {
                                postMessage({ status: 'loading', output: `モデル構築中...` });
                            }
                        }
                    });
                    generator.modelId = modelId;
                }
            } catch (e) {
                console.warn('Model load failed, falling back to tiny GPT-2:', e);
                // fallback to tiny GPT-2 for CPU only
                const fallbackId = 'Xenova/gpt2';
                generator = await pipeline('text-generation', fallbackId, {
                    device: 'wasm',
                    dtype: 'q4',
                    progress_callback: (x) => {
                        if (x.status === 'download') {
                            postMessage({ status: 'loading', output: `小モデルDL中: ${x.file} (${Math.round(x.progress)}%)` });
                        } else if (x.status === 'init') {
                            postMessage({ status: 'loading', output: `小モデル構築中...` });
                        }
                    }
                });
                generator.modelId = fallbackId;
                warningPrefix = "⚠️ 大きなモデルのロードに失敗したため、軽量GPT-2にフォールバックしました。\n\n" + warningPrefix;
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

            let generatedText = warningPrefix;
            
            // ストリーマーの設定（逐次出力をUIに送る）
            const streamer = new TextStreamer(generator.tokenizer, {
                skip_prompt: true,
                skip_special_tokens: true,
                callback_function: (text) => {
                    generatedText += text;
                    postMessage({ status: 'chunk', output: generatedText });
                }
            });

            // Run inference – choose correct call signature based on model type
            try {
                if (useVision) {
                    // Vision pipeline expects the formatted inputs object (texts + images)
                    await generator(inputs, { max_new_tokens: 1024, temperature: 0.1, do_sample: false, streamer });
                } else if (generator.modelId === 'Xenova/gpt2') {
                    // Tiny fallback model expects a plain prompt string
                    await generator(prompt, { max_new_tokens: 1024, temperature: 0.1, do_sample: false, streamer });
                } else {
                    // Standard text‑generation model expects the formatted chat string (inputs)
                    await generator(inputs, { max_new_tokens: 1024, temperature: 0.1, do_sample: false, streamer });
                }
            } catch (e) {
                console.warn('Inference failed, using echo fallback:', e);
                generatedText += '\n' + prompt;
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
