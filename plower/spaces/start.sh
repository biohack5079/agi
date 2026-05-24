#!/bin/bash

# Spaceの設定画面(Variables)での入力ミスを強制的に修正
export OLLAMA_HOST=0.0.0.0:7860
# 本番環境とローカル環境(localhost)からのアクセスを許可します
export OLLAMA_ORIGINS="https://your-domain.com,http://localhost:*,http://127.0.0.1:*"

# Ollamaサーバーをバックグラウンドで起動
ollama serve &
pid=$!

# サーバーが立ち上がるまで少し待機
sleep 5

echo "🔴 モデルのダウンロードを開始します..."

echo "--- Pulling gemma:7b ---"
ollama pull gemma:7b

echo "--- Pulling gpt-oss:20b ---"
ollama pull gpt-oss:20b

echo "🟢 すべてのモデルの準備が完了しました！"

# プロセスが終了しないように待機
wait $pid
