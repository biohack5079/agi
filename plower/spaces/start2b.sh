#!/bin/bash

# Spaceの設定画面(Variables)での入力ミスを強制的に修正
export OLLAMA_HOST=0.0.0.0:7860
export OLLAMA_ORIGINS="https://your-domain.com,http://localhost:*,http://127.0.0.1:*"

# Ollamaサーバーをバックグラウンドで起動
ollama serve &
pid=$!

# サーバーが立ち上がるまで少し待機
sleep 5

echo "🔴 モデルのダウンロードを開始します..."

echo "--- Pulling gemma:2b (Test Mode) ---"
ollama pull gemma:2b

echo "🟢 すべてのモデルの準備が完了しました！"

# プロセスが終了しないように待機
wait $pid
