// 永続化された文書を格納 (LocalStorageからロード)
let persistentDocuments = []; 

// 現在解析対象となっている画像データ (Base64)
let currentImageBase64 = null;

// 現在解析対象となっている画像のベース名
let currentImageName = "";

// 現在解析対象となっている画像のオリジナルデータ (高画質)
let currentImageBlob = null;

// 言語設定の判定 (日本語以外なら英語モード)
const isEn = !navigator.language.startsWith('ja');

const PREVIEW_MAX_DOCS = 5; // コンテンツ表示エリアに表示する最大ファイル数

// --- IndexedDB 初期化 ---
const dbName = "PlowerDB";
const storeName = "documents";

function openDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(dbName, 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            db.createObjectStore(storeName);
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
}

// --- LocalStorageからの文書ロードとファイル一覧の表示 ---
async function loadDocuments() {
    try {
        // 移行期対応: LocalStorageにデータがあれば取得して移行
        const legacyDocs = localStorage.getItem('plowerRAGDocs');
        if (legacyDocs) {
            persistentDocuments = JSON.parse(legacyDocs);
            await saveDocuments(); // 新しいDBに保存
            localStorage.removeItem('plowerRAGDocs'); // 移行完了後削除
        } else {
            const db = await openDB();
            const tx = db.transaction(storeName, "readonly");
            const store = tx.objectStore(storeName);
            const request = store.get("plowerRAGDocs");
            persistentDocuments = await new Promise((resolve) => {
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => resolve([]);
            });
        }
        updateFileListDisplay();
    } catch (e) {
        console.error("Failed to load documents:", e);
        persistentDocuments = [];
    }
}

// --- LocalStorageへの文書保存 ---
async function saveDocuments() {
    try {
        const db = await openDB();
        const tx = db.transaction(storeName, "readwrite");
        const store = tx.objectStore(storeName);
        store.put(persistentDocuments, "plowerRAGDocs");
    } catch (e) {
        console.error("Failed to save documents:", e);
    }
}

// ヘルパー: Blobを同期フォルダに書き込む
async function saveBlobToDirectory(blob, filename) {
    if (!directoryHandle) return false;
    try {
        const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
        const writable = await fileHandle.createWritable();
        await writable.write(blob);
        await writable.close();
        return true;
    } catch (e) {
        console.error("Failed to auto-save to directory:", e);
        return false;
    }
}

// LocalStorageをリセットする関数
async function resetDocuments() {
    const msgConfirm = isEn 
        ? "Are you sure you want to delete all RAG source documents?\n(This cannot be undone. All uploaded files will be cleared from LocalStorage.)"
        : "本当にRAGソース文書を全て削除しますか？\n（この操作は元に戻せません。アップロードされたファイルがLocalStorageから全て消去されます。）";
    if (confirm(msgConfirm)) {
        try {
            const db = await openDB();
            const tx = db.transaction(storeName, "readwrite");
            tx.objectStore(storeName).clear();

            persistentDocuments = [];
            document.getElementById('pasteArea').value = '';
            clearOcrDisplay();

            // 同期設定のクリア
            directoryHandle = null;
            if (syncInterval) clearInterval(syncInterval);

            // UIを更新
            updateFileListDisplay(); 
            
            alert(isEn ? "All RAG source documents have been reset." : "RAGソース文書を全てリセットしました。");
        } catch (e) {
            console.error("Failed to reset documents:", e);
            alert(isEn ? "An error occurred during reset." : "リセット中にエラーが発生しました。");
        }
    }
}

// OCR/画像関連の表示をクリアするヘルパー関数
function clearOcrDisplay() {
    // 既存のOCR関連要素をクリア
    // 画像とステータスを両方削除します
    document.querySelectorAll('#fileContent img, #fileContent .ocr-status').forEach(el => el.remove());
}

// --- ファイル一覧表示の更新とクリックイベント設定 ---
function updateFileListDisplay() {
    const fileListUl = document.getElementById('fileListUl');
    const fileContentDiv = document.getElementById('fileContent');
    fileListUl.innerHTML = '';
    
    // 解析中の画像やステータス表示を一時退避（リスト更新で消えないようにするため）
    const ocrElements = Array.from(fileContentDiv.children).filter(el => 
        el.classList.contains('ocr-status') || el.tagName === 'IMG' || (el.tagName === 'DIV' && el.querySelector('img'))
    );

    // ファイル名のリストを生成
    persistentDocuments.forEach((doc, index) => {
        const li = document.createElement('li');
        
        // モバイル対応: レイアウトをFlexにしてメニューボタンを追加
        li.style.display = 'flex';
        li.style.justifyContent = 'space-between';
        li.style.alignItems = 'center';

        const nameSpan = document.createElement('span');
        nameSpan.textContent = doc.name;
        nameSpan.style.flexGrow = '1';
        nameSpan.style.overflow = 'hidden';
        nameSpan.style.textOverflow = 'ellipsis';
        nameSpan.style.whiteSpace = 'nowrap';
        li.appendChild(nameSpan);

        // メニューボタン (︙)
        const menuBtn = document.createElement('span');
        menuBtn.innerHTML = '&#x22EE;'; // 縦の三点リーダー
        menuBtn.style.cursor = 'pointer';
        menuBtn.style.padding = '0 5px 0 10px';
        menuBtn.style.fontSize = '1.2em';
        menuBtn.onclick = (e) => {
            e.stopPropagation();
            const rect = e.target.getBoundingClientRect();
            createContextMenu({ pageX: rect.left + window.scrollX, pageY: rect.bottom + window.scrollY, preventDefault: () => {} }, index);
        };
        li.appendChild(menuBtn);

        li.title = doc.name; // ホバーでフルネームを表示
        li.dataset.docIndex = index;
        li.onclick = () => {
            clearOcrDisplay();
            showDocumentContent(index);
        };
        // 右クリックメニュー (コンテキストメニュー) の追加
        li.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            createContextMenu(e, index);
        });
        fileListUl.appendChild(li);
    });
    
    // コンテンツ表示エリアの初期表示（最新の数ファイル）
    let initialContent = isEn ? '<h3>RAG Source Document Preview (Latest 5)</h3>\n' : '<h3>RAGソース文書プレビュー (最新5件)</h3>\n';
    const recentDocs = persistentDocuments.slice(-PREVIEW_MAX_DOCS).reverse();
    
    if (recentDocs.length > 0) {
        recentDocs.forEach(doc => {
            initialContent += `<p><strong>【${doc.name}】</strong></p>`;
            if (doc.content.startsWith('data:image/')) {
                // 画像の場合はサムネイルを表示
                initialContent += `<div style="margin-bottom:10px;"><img src="${doc.content}" style="max-width:200px; max-height:150px; border:1px solid #ccc; border-radius:4px;"></div>`;
            } else {
                // テキストの場合は内容の一部を表示
                initialContent += `<pre>--- ${isEn ? 'File Name' : 'ファイル名'}: ${doc.name} ---\n${doc.content.slice(0, 300)}${doc.content.length > 300 ? '...' : ''}</pre>\n`;
            }
        });
    } else {
        initialContent += isEn ? '<p>No RAG source documents available.</p>' : '<p>現在RAGのソースとなる文書はありません。</p>';
    }
    fileContentDiv.innerHTML = initialContent;
    
    // 退避しておいたOCR要素をプレビューエリアに再挿入
    ocrElements.forEach(el => fileContentDiv.prepend(el));
}

// --- ファイル名クリック時の内容表示 ---
function showDocumentContent(index) {
    const fileContentDiv = document.getElementById('fileContent');
    const doc = persistentDocuments[index];
    if (doc) {
        let contentHtml = `<h3>${isEn ? 'Selected File' : '選択中のファイル'}: ${doc.name}</h3>`;
        if (doc.content.startsWith('data:image/')) {
            contentHtml += `<img src="${doc.content}" style="max-width:100%; border:1px solid #ddd; border-radius:8px; box-shadow:0 2px 8px rgba(0,0,0,0.1);">`;
        } else {
            contentHtml += `<pre>${doc.content}</pre>`;
        }
        fileContentDiv.innerHTML = contentHtml;
    }
}

// --- コンテキストメニュー (右クリック) 関連 ---
function createContextMenu(e, index) {
    // 既存のメニューがあれば削除
    const existingMenu = document.getElementById('customContextMenu');
    if (existingMenu) existingMenu.remove();

    const menu = document.createElement('div');
    menu.id = 'customContextMenu';
    menu.style.position = 'absolute';
    menu.style.left = `${e.pageX}px`;
    menu.style.top = `${e.pageY}px`;
    menu.style.backgroundColor = 'white';
    menu.style.border = '1px solid #ccc';
    menu.style.boxShadow = '2px 2px 5px rgba(0,0,0,0.2)';
    menu.style.zIndex = '1000';
    menu.style.padding = '5px 0';
    menu.style.minWidth = '120px';
    menu.style.borderRadius = '4px';

    const createMenuItem = (text, onClick, color = 'black') => {
        const item = document.createElement('div');
        item.textContent = text;
        item.style.padding = '8px 12px';
        item.style.cursor = 'pointer';
        item.style.fontSize = '14px';
        item.style.color = color;
        item.onmouseover = () => item.style.backgroundColor = '#f0f0f0';
        item.onmouseout = () => item.style.backgroundColor = 'white';
        item.onclick = (ev) => {
            ev.stopPropagation();
            menu.remove();
            onClick();
        };
        return item;
    };

    menu.appendChild(createMenuItem(isEn ? 'Rename' : '名前を変更', () => renameDocument(index)));
    menu.appendChild(createMenuItem(isEn ? 'Delete' : '削除', () => deleteDocument(index), 'red'));

    document.body.appendChild(menu);

    const closeMenu = (event) => {
        if (!menu.contains(event.target)) {
            menu.remove();
            document.removeEventListener('click', closeMenu);
        }
    };
    setTimeout(() => document.addEventListener('click', closeMenu), 0);
}

// 共通のファイル名入力ダイアログ (拡張子を除いた部分を選択状態にする)
function showRenameDialog(titleText, initialValue) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.position = 'fixed';
        overlay.style.top = '0';
        overlay.style.left = '0';
        overlay.style.width = '100%';
        overlay.style.height = '100%';
        overlay.style.backgroundColor = 'rgba(0,0,0,0.5)';
        overlay.style.zIndex = '2000';
        overlay.style.display = 'flex';
        overlay.style.justifyContent = 'center';
        overlay.style.alignItems = 'center';

        const dialog = document.createElement('div');
        dialog.style.backgroundColor = 'white';
        dialog.style.padding = '20px';
        dialog.style.borderRadius = '8px';
        dialog.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
        dialog.style.minWidth = '300px';

        const title = document.createElement('h3');
        title.textContent = titleText;
        title.style.marginTop = '0';
        title.style.marginBottom = '15px';
        
        const input = document.createElement('input');
        input.type = 'text';
        input.value = initialValue;
        input.style.width = '100%';
        input.style.padding = '8px';
        input.style.marginBottom = '20px';
        input.style.boxSizing = 'border-box';
        input.style.fontSize = '16px';

        const btnContainer = document.createElement('div');
        btnContainer.style.display = 'flex';
        btnContainer.style.justifyContent = 'flex-end';
        btnContainer.style.gap = '10px';

        const closeDialog = (val) => {
            overlay.remove();
            resolve(val);
        };

        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = isEn ? 'Cancel' : 'キャンセル';
        cancelBtn.style.padding = '6px 12px';
        cancelBtn.style.cursor = 'pointer';
        cancelBtn.onclick = () => closeDialog(null);
        
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.padding = '6px 12px';
        okBtn.style.cursor = 'pointer';
        okBtn.onclick = () => {
            const val = input.value.trim();
            if (val) closeDialog(val);
        };

        btnContainer.appendChild(cancelBtn);
        btnContainer.appendChild(okBtn);
        dialog.appendChild(title);
        dialog.appendChild(input);
        dialog.appendChild(btnContainer);
        overlay.appendChild(dialog);
        document.body.appendChild(overlay);

        input.focus();
        const lastDotIndex = initialValue.lastIndexOf('.');
        if (lastDotIndex > 0) {
            input.setSelectionRange(0, lastDotIndex);
        } else {
            input.select();
        }

        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') okBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
        });
    });
}

async function renameDocument(index) {
    const doc = persistentDocuments[index];
    const newName = await showRenameDialog(isEn ? 'Rename' : '名前を変更', doc.name);
    if (newName && newName !== doc.name) {
        doc.name = newName;
        await saveDocuments();
        updateFileListDisplay();
    }
}

async function deleteDocument(index) {
    const doc = persistentDocuments[index];
    const msg = isEn ? `Are you sure you want to delete "${doc.name}"?` : `本当に「${doc.name}」を削除しますか？`;
    if (confirm(msg)) {
        persistentDocuments.splice(index, 1);
        await saveDocuments();
        updateFileListDisplay();
    }
}

// --- File System Access API 関連 ---
let directoryHandle = null;
let syncInterval = null;

// ローカルフォルダと同期する関数
async function syncLocalFolder() {
    if (!('showDirectoryPicker' in window)) {
        alert(isEn ? 'Your browser does not support File System Access API.' : 'お使いのブラウザはローカルフォルダ同期(File System Access API)をサポートしていません。PC版ChromeやEdgeをご利用ください。');
        return;
    }

    // 既存の同期を停止
    if (syncInterval) clearInterval(syncInterval);

    try {
        // ユーザーにフォルダを選択させる
        const handle = await window.showDirectoryPicker({ mode: 'read' });
        directoryHandle = handle;
        
        const msg = isEn 
            ? `Start syncing with folder "${handle.name}"?\nFiles in this folder will be automatically synced.`
            : `フォルダ「${handle.name}」と同期を開始しますか？\nこのフォルダ内のファイルは自動的に同期（追加・更新）されます。`;

        if (confirm(msg)) {
            // 初回読み込み (UI表示あり)
            await loadFilesFromDirectory(false);
            // 自動同期タイマーを開始 (10秒ごとにチェック)
            syncInterval = setInterval(() => loadFilesFromDirectory(true), 10000);
        }

    } catch (err) {
        if (err.name !== 'AbortError') {
            console.error('フォルダ選択中にエラーが発生しました:', err);
            alert(isEn ? 'Error selecting folder.' : 'フォルダ選択中にエラーが発生しました。');
        }
    }
}

// 選択されたディレクトリからファイルを読み込む関数
async function loadFilesFromDirectory(isSilent = false) {
    if (!directoryHandle) return;

    const fileContentDiv = document.getElementById('fileContent');
    
    // サイレントモードでない場合のみローディング表示
    if (!isSilent) {
        fileContentDiv.innerHTML = isEn ? '<h3>Syncing files...</h3><div class="spinner"></div>' : '<h3>同期フォルダからファイルを読み込み中...</h3><div class="spinner"></div>';
    }

    try {
        const scannedDocs = [];

        // 再帰的にファイルを読み込むヘルパー関数
        async function readDirectoryRecursive(dirHandle, pathPrefix = '') {
            for await (const entry of dirHandle.values()) {
                if (entry.kind === 'file') {
                    if (/\.(txt|md|log|py|js|json|c|cpp|h|java|html|css|csv|rb|go|rs|php)$/i.test(entry.name)) {
                        try {
                            const file = await entry.getFile();
                            const content = await file.text();
                            // パスを含めた名前で保存 (例: subfolder/file.txt)
                            scannedDocs.push({ name: pathPrefix + entry.name, content: content });
                        } catch (e) {
                            console.warn(`Skipped file: ${entry.name}`, e);
                        }
                    }
                } else if (entry.kind === 'directory') {
                    await readDirectoryRecursive(entry, pathPrefix + entry.name + '/');
                }
            }
        }

        await readDirectoryRecursive(directoryHandle);

        if (scannedDocs.length === 0) {
            if (!isSilent) {
                alert(isEn ? "No text files found." : "読み込み可能なテキストファイルが見つかりませんでした。");
                updateFileListDisplay();
            }
            return;
        }

        let changesMade = false;
        let addedCount = 0;
        let updatedCount = 0;

        // マージロジック: 既存の文書を更新または新規追加
        for (const doc of scannedDocs) {
            const existingIndex = persistentDocuments.findIndex(d => d.name === doc.name);
            if (existingIndex !== -1) {
                // 内容が変更されている場合のみ更新
                if (persistentDocuments[existingIndex].content !== doc.content) {
                    persistentDocuments[existingIndex].content = doc.content;
                    changesMade = true;
                    updatedCount++;
                }
            } else {
                // 新規追加
                persistentDocuments.push(doc);
                changesMade = true;
                addedCount++;
            }
        }

        if (changesMade) {
            saveDocuments(); // LocalStorageに保存
            updateFileListDisplay(); // ファイル一覧を更新
            
            if (!isSilent) {
                alert(isEn ? `Synced: ${addedCount} added, ${updatedCount} updated.` : `フォルダ「${directoryHandle.name}」から ${addedCount} 件追加、${updatedCount} 件更新しました。`);
            } else {
                console.log(`Auto-sync: Added ${addedCount}, Updated ${updatedCount}`);
            }
        } else {
            if (!isSilent) {
                alert(isEn ? "Files are up to date." : "ファイルの内容は最新です。");
                updateFileListDisplay(); // 表示を復元
            }
        }

    } catch (err) {
        console.error('フォルダからのファイル読み込み中にエラーが発生しました:', err);
        if (!isSilent) {
            alert(isEn ? 'Error syncing files.' : 'フォルダからのファイル読み込み中にエラーが発生しました。');
            updateFileListDisplay(); // 表示を復元
        }
    }
}

// --- ファイル入力のイベントリスナー ---
document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('fileInput');
    if (fileInput) {
        fileInput.addEventListener('change', function () {
            const files = this.files;
            if (files.length === 0) return;
            
            Array.from(files).forEach(async file => {
                if (file.size > 10 * 1024 * 1024) {
                    alert(isEn ? `File "${file.name}" exceeds 10MB limit.` : `ファイル「${file.name}」はサイズ制限（10MB）を超えているためスキップされました。`);
                    return;
                }

                if (file.type.startsWith('image/')) {
                    await processImageSource(file);
                } else {
                    const reader = new FileReader();
                    reader.onload = function (e) {
                        persistentDocuments.push({ name: file.name, content: e.target.result });
                        saveDocuments(); // 非同期だが順序不問のためそのまま
                        updateFileListDisplay();
                    };
                    reader.readAsText(file);
                }
            });
            
            this.value = ''; // 連続アップロードのためにinputをクリア
        });
    }
});

// --- 貼り付け画像処理のイベントリスナー (OCR連携ロジック) ---
async function handlePaste(e) {
    const items = e.clipboardData.items;
    for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.indexOf('image') !== -1) {
            e.preventDefault(); 
            const blob = item.getAsFile();
            processImageSource(blob);
            break;
        }
    }
}

// --- 画像解析(OCR)とプレビュー・JPG保存処理 ---
async function processImageSource(fileOrBlob) {
    const isFile = fileOrBlob instanceof File;
    currentImageBlob = fileOrBlob; // オリジナルの高画質データを保持
    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;

    // ブラウザの貼り付けなどで「image.png」や「img」という名前になることが多いため、
    // 名前が汎用的な場合はタイムスタンプ付きの長い名前に置き換える
    const baseName = isFile ? fileOrBlob.name.replace(/\.[^/.]+$/, "") : "";
    const isGeneric = !baseName || /^(image|img)\d*$/i.test(baseName);
    currentImageName = isGeneric ? `pasted_image_${timestamp}` : baseName;

    const name = `${currentImageName}.jpg`;
    const fileContentDiv = document.getElementById('fileContent');

    const processingMessage = document.createElement('p');
    processingMessage.className = 'ocr-status';
    processingMessage.style.fontWeight = 'bold';
    processingMessage.textContent = isEn ? `Image ready: ${name}` : `画像を確認しました: ${name}`;
    fileContentDiv.prepend(processingMessage);

    const reader = new FileReader();
    reader.onload = async function (event) {
        const base64Image = event.target.result;

        const container = document.createElement('div');
        container.style.margin = "10px 0";
        container.style.padding = "10px";
        container.style.border = "1px solid #ddd";
        container.style.borderRadius = "5px";
        container.style.backgroundColor = "#fff";

        const img = document.createElement('img');
        img.src = base64Image;
        img.style.maxWidth = '100%';
        img.style.display = 'block';
        img.style.marginBottom = '10px';
        container.appendChild(img);

        const dlBtn = document.createElement('button');
        dlBtn.textContent = isEn ? 'Download as JPG' : 'JPGとして保存';
        dlBtn.style.padding = "5px 15px";
        
        // JPG変換ロジック
        const tempImg = new Image();
        tempImg.onload = () => {
            const canvas = document.createElement('canvas');
            // メモリ消費を抑えるため、最大サイズを1024pxに制限
            const MAX_SIZE = 1024;
            let width = tempImg.width;
            let height = tempImg.height;
            if (width > height) {
                if (width > MAX_SIZE) {
                    height *= MAX_SIZE / width;
                    width = MAX_SIZE;
                }
            } else {
                if (height > MAX_SIZE) {
                    width *= MAX_SIZE / height;
                    height = MAX_SIZE;
                }
            }
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(tempImg, 0, 0);
            const jpegUrl = canvas.toDataURL('image/jpeg', 0.8);
            dlBtn.onclick = () => {
                const link = document.createElement('a');
                link.href = jpegUrl;
                link.download = name.split('.')[0] + ".jpg";
                link.click();
            };
            currentImageBase64 = jpegUrl; // LLM送信用に保持
        };
        tempImg.src = base64Image;

        container.appendChild(dlBtn);
        fileContentDiv.prepend(container);

        // 解析を待たずに保存を確認
        setTimeout(() => {
            const msg = isEn 
                ? `Image "${name}" detected. Save this image to RAG source?` 
                : `画像「${name}」を検出しました。この画像をRAGソース（永続ファイル）に保存しますか？`;
            if (confirm(msg)) {
                saveOcrTextAsFile();
            }
        }, 100);
    };
    reader.readAsDataURL(fileOrBlob);
}

// --- OCR/貼付テキストのファイル保存と永続化 ---

async function saveOcrTextAsFile() {
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    if (!currentImageBase64 && !pasteAreaContent) {
        alert(isEn ? "No content to save." : "永続化する内容がありません。");
        return;
    }

    const now = new Date();
    const pad = (num) => num.toString().padStart(2, '0');
    const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    
    // 画面上の表示やダイアログの初期値は .jpg に統一（ユーザーへの表示用）
    let defaultFilename = currentImageBase64 ? `${currentImageName || 'plower_image_' + timestamp}.jpg` : `plower_memo_${timestamp}.txt`;
    const filename = await showRenameDialog(isEn ? 'Save As' : '名前を付けて保存', defaultFilename);
    if (!filename) return;

    let contentToSave = '';
    let fileBlob;

    // 画像がある場合の処理
    if (currentImageBase64) {
        // ローカル保存用のファイル名は、UI上の拡張子に関わらず .png に強制（高画質を維持）
        const downloadName = filename.replace(/\.[^/.]+$/, "") + ".png";

        // 1. ローカルフォルダ/ダウンロード用 (オリジナルの Blob をそのまま使用 = 高画質)
        fileBlob = currentImageBlob;

        // 2. 内部ストレージ(IndexedDB)用 (JPG - ブラウザの容量制限対策のため圧縮版を使用)
        const tempImg = new Image();
        await new Promise(resolve => { tempImg.onload = resolve; tempImg.src = currentImageBase64; });
        const canvas = document.createElement('canvas');
        canvas.width = tempImg.width; canvas.height = tempImg.height;
        canvas.getContext('2d').drawImage(tempImg, 0, 0);
        contentToSave = canvas.toDataURL('image/jpeg', 0.7);

        // 同期フォルダがあれば .png として保存
        if (directoryHandle) {
            await saveBlobToDirectory(fileBlob, downloadName);
        }

        // ファイルとしてダウンロード実行 (.png として保存)
        if (fileBlob) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(fileBlob);
            link.download = downloadName;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        alert(isEn ? `Saved as "${downloadName}".` : `「${downloadName}」として保存し、RAGソースに追加しました。`);
    } else {
        contentToSave = pasteAreaContent;
        fileBlob = new Blob([contentToSave], { type: 'text/plain;charset=utf-8' });

        if (fileBlob) {
            const link = document.createElement('a');
            link.href = URL.createObjectURL(fileBlob);
            link.download = filename;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        }
        alert(isEn ? `Saved as "${filename}".` : `「${filename}」として保存し、RAGソースに追加しました。`);
    }

    if (contentToSave) {
        persistentDocuments.push({ name: filename, content: contentToSave });
        await saveDocuments();
    }
    
    document.getElementById('pasteArea').value = '';
    currentImageBase64 = null;
    currentImageBlob = null;
    currentImageName = "";
    clearOcrDisplay(); // 重要な変更点：保存が完了したら画像とステータスをクリア
    updateFileListDisplay(); // ファイルリストを更新
}


// --- LLMリクエスト共通関数 (翻訳・回答生成で再利用) ---
async function performLlmRequest(modelSelect, llmPrompt, apiKey, onChunk = null, imageData = null) {
    let result = '';
    let endpoint = '';
    let bodyData = {};
    let isStreaming = false;
    
    const isGeminiCloudModel = modelSelect.toLowerCase().startsWith('gemini');
    const isSarasinaModel = modelSelect.toLowerCase().includes('sarasina');
    
    if (isGeminiCloudModel) {
        // --- Gemini Cloud Model ---
        if (!apiKey) throw new Error("Gemini API Key is required.");

        // 利用可能な最新かつ安定したモデルエイリアスのみに絞り込みます
        const candidates = [
        'gemini-2.5-flash',      // 最新の安定版（メイン利用に推奨）
        'gemini-2.5-flash-lite', // 軽量・高速版（コスト効率重視）
        'gemini-1.5-flash'       // 以前の安定版（予備として）
        ];

        let success = false;
        let lastError = null;

        for (const modelVersion of candidates) {
            try {
                console.log(`Trying Gemini model: ${modelVersion}`);
                const currentEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelVersion}:generateContent?key=${apiKey}`;
                const currentBody = {
                    contents: [{ 
                        parts: [
                            { text: llmPrompt },
                            ...(imageData ? [{ inline_data: { mime_type: "image/jpeg", data: imageData.split(',')[1] } }] : [])
                        ] 
                    }],
                    generationConfig: { temperature: 0.1 }
                };

                const response = await fetch(currentEndpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(currentBody)
                });

                if (!response.ok) {
                    const errorText = await response.text();
                    if (response.status === 404 || response.status === 503) {
                        lastError = new Error(`Gemini API Error (${response.status}): ${errorText}`);
                        continue;
                    }
                    if (response.status === 400 || response.status === 403) {
                        localStorage.removeItem('plowerGeminiApiKey');
                        throw new Error(`Gemini API Auth Error (${response.status}): ${errorText}`);
                    }
                    throw new Error(`Gemini API Error (${response.status}): ${errorText}`);
                }

                const json = await response.json();
                if (json.candidates && json.candidates[0].content) {
                    result = json.candidates[0].content.parts.map(p => p.text).join('');
                    success = true;
                    break; 
                } else {
                    throw new Error(`Unexpected response format from ${modelVersion}`);
                }
            } catch (e) {
                lastError = e;
                console.error(`Error with model ${modelVersion}:`, e);
            }
        }

        if (!success) throw lastError || new Error('All Gemini candidates failed.');
        if (onChunk) onChunk(result);
        return result;

    } else if (isSarasinaModel) {
        // --- Sarasina Model ---
        endpoint = 'http://localhost:8001/api/sarasina';
        bodyData = { model: modelSelect, prompt: llmPrompt, temperature: 0.1 };
        
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(bodyData)
        });
        
        if (!response.ok) throw new Error(`Sarasina Error: ${response.statusText}`);
        const json = await response.json();
        result = json.response || json.detail || "";
        if (onChunk) onChunk(result);
        return result;

    } else {
        // --- Ollama Model ---
        let hfUrl = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
        if (hfUrl.endsWith('/')) hfUrl = hfUrl.slice(0, -1);
        endpoint = hfUrl.endsWith('/api/generate') ? hfUrl : `${hfUrl}/api/generate`;

        bodyData = {
            model: modelSelect,
            prompt: llmPrompt,
            stream: true,
            images: imageData ? [imageData.split(',')[1]] : undefined,
            options: { temperature: 0.1, num_ctx: 4096 } // CPUリソースに合わせてコンテキスト窓を調整
        };

        return await fetchOllamaStream(endpoint, bodyData, onChunk);
    }
}

// Ollamaストリーミング処理のヘルパー
async function fetchOllamaStream(endpoint, bodyData, onChunk) {
    let result = '';
    const hfToken = localStorage.getItem('plowerHfToken');
    const headers = { 'Content-Type': 'application/json' };
    
    // Hugging Face Space等へのアクセス用に認証トークンを付与
    if (hfToken) {
        headers['Authorization'] = `Bearer ${hfToken}`;
    }

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(bodyData)
    });

    const contentType = response.headers.get("content-type");
    if (contentType && contentType.includes("text/html")) {
         throw new Error("Server returned HTML. Check URL or Space status.");
    }

    if (!response.ok) {
        if (response.status === 404) throw new Error(`Model '${bodyData.model}' not found.`);
        if (response.status === 403) throw new Error(`Access Forbidden (403). Check Hugging Face Token or OLLAMA_ORIGINS.`);
        throw new Error(`Ollama Error: ${response.status} ${response.statusText}`);
    }

    if (!response.body) throw new Error("No response body.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value, { stream: true });
        chunk.trim().split('\n').forEach(line => {
            if (line) {
                try {
                    const json = JSON.parse(line);
                    if (json.response) {
                        result += json.response;
                        if (onChunk) onChunk(result);
                    }
                } catch (e) {}
            }
        });
    }
    return result;
}

// --- モデル送信ロジック ---
async function sendToModel() {
    const userInputElement = document.getElementById('userInput');
    const userInput = userInputElement.value.trim();
    const pasteAreaContent = document.getElementById('pasteArea').value.trim();
    const chatLog = document.getElementById('chatLog');
    const sendButton = document.getElementById('sendButton');
    const modelSelect = document.getElementById('modelSelect').value;
    const geminiApiKey = document.getElementById('geminiApiKey').value.trim();

    if (!userInput) {
        alert(isEn ? "Please enter a question." : "質問を入力してください。");
        return;
    }

    sendButton.disabled = true;
    sendButton.textContent = isEn ? 'Sending...' : '送信中...';
    chatLog.innerHTML += `<p><strong>${isEn ? 'Question' : '質問'}:</strong> ${userInput}</p>`;
    const responseParagraph = document.createElement('p');
    responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> (${isEn ? 'Processing...' : '処理中...'})`;
    chatLog.appendChild(responseParagraph);

    // 全てのRAGソースを統合
    let allDocuments = [...persistentDocuments];
    if (pasteAreaContent) {
        // 貼り付けエリアのテキストは一時文書として扱う
        allDocuments.push({ name: '貼付けテキスト(一時)', content: pasteAreaContent });
    }
    
    // --- フロントエンドでの検索処理を廃止 ---
    // ユーザーの指示に基づき、ローカルでの検索や翻訳を行わず、全ての文書をコンテキストとしてLLMに渡す。
    console.log(`全ての文書(${allDocuments.length}件)をコンテキストとして使用します。`);
    
    let imageDataToSend = currentImageBase64;

    // 文書リストからテキストコンテキストを作成。
    // 画像データ（Base64文字列）が混ざるとプロンプトが巨大になり、AIが混乱するため、[Image Data]というラベルに置き換える。
    const context = allDocuments.map(doc => {
        if (doc.content.startsWith('data:image/')) {
            // 質問の中でファイル名が言及されている画像を優先的にVision入力として選択
            const isMentioned = userInput.toLowerCase().includes(doc.name.toLowerCase()) || 
                               userInput.toLowerCase().includes(doc.name.split('.')[0].toLowerCase());
            if (isMentioned) {
                imageDataToSend = doc.content;
            }
            return `File: ${doc.name}\nContent: [Image Data (Vision Input)]`;
        }
        return `File: ${doc.name}\nContent: ${doc.content}`;
    }).join('\n\n').slice(0, 15000);

    // プロンプトの生成: 質問と同じ言語で回答させるための指示を明確化。
    // ブラウザの言語設定(isEn)に依存せず、常に同じ構造のプロンプトを渡すことで、モデルの動作を安定させます。
    const prompt = `You are a helpful assistant. Your task is to answer the user's question based *only* on the provided [Reference Documents].

IMPORTANT INSTRUCTIONS:
1.  **Answer in the same language as the user's [Question].** (If the question is in Japanese, answer in Japanese. If in English, answer in English).
2.  Base your answer strictly on the information within the [Reference Documents]. Do not use any external knowledge.
3.  **Language Handling:** The documents may be in a different language than the question. You must translate and interpret the documents to answer the question accurately.
4.  If the answer cannot be found in the [Reference Documents], you MUST state that the information is not available, in the same language as the question.
5.  **Visual Reference:** If an image (marked as [Image Data]) is requested, use the vision input to provide details.

[Reference Documents]
${context}

[Question]
${userInput}`;

    // --- 回答生成 ---
    try {
        // 共通関数を使ってリクエスト
        const finalResult = await performLlmRequest(modelSelect, prompt, geminiApiKey, (chunkText) => {
            // ストリーミング更新
            responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${chunkText.replace(/\n/g, '<br>')}`;
            chatLog.scrollTop = chatLog.scrollHeight;
        }, imageDataToSend);

        // 最終結果の表示 (非ストリーミングモデル用)
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ${finalResult.replace(/\n/g, '<br>')}`;
        
        // 画像を解析に使用した場合、保存を提案する
        if (currentImageBase64) {
            const savePrompt = document.createElement('div');
            savePrompt.style.marginTop = '15px';
            savePrompt.style.padding = '10px';
            savePrompt.style.border = '1px dashed #ccc';
            savePrompt.innerHTML = `<p style="margin:0 0 10px 0; font-size:0.9em;">${isEn ? 'Analysis used an image. Save it locally?' : '画像を解析に使用しました。この画像をローカルに保存しますか？'}</p>`;
            
            const dlBtn = document.createElement('button');
            dlBtn.textContent = isEn ? 'Save as JPG' : '画像をJPGで保存';
            const imgDataToSave = currentImageBase64;
            dlBtn.onclick = () => {
                const link = document.createElement('a');
                link.href = imgDataToSave;
                link.download = `plower_analyzed_${Date.now()}.jpg`;
                link.click();
            };
            savePrompt.appendChild(dlBtn);
            responseParagraph.appendChild(savePrompt);
            // 解析が終わったら画像キャッシュをクリア（次の質問で画像を使わないため）
            currentImageBase64 = null;
            currentImageBlob = null;
            currentImageName = "";
        }
        
        userInputElement.value = ''; // 質問欄をクリア

    } catch (error) {
        let errorMsg = error.message;
        // HTTPS環境からHTTP(ローカル)へ接続しようとして失敗した場合のヒントを追加
        const isNetworkError = error.name === 'TypeError' || error.message.toLowerCase().includes('fetch') || error.message.toLowerCase().includes('network');
        
        if (isNetworkError) {
            if (window.location.protocol === 'file:') {
                errorMsg += isEn 
                    ? "<br>⚠️ <strong>Security Restriction:</strong> You cannot make API requests when opening the file directly (file://). Please use a local server like 'Live Server' in VS Code or run 'npx serve'."
                    : "<br>⚠️ <strong>セキュリティ制限:</strong> ファイルを直接ブラウザで開いている(file://)ため、APIリクエストが遮断されました。VS CodeのLive Serverを使用するか、'npx serve' 等のローカルサーバー経由で開いてください。";
            } else {
                errorMsg += isEn 
                    ? "<br>⚠️ Request Blocked: Check your Internet connection and API Token. If using Gemma 3, make sure you've accepted the license on the Hugging Face model page."
                    : "<br>⚠️ リクエストが遮断されました: トークンの権限、ネット接続、広告ブロックを確認してください。Gemma 3を使用する場合、HFのモデルページでライセンスへの同意が必要です。";
                errorMsg += `<br><small>Debug Info: ${error.name} - ${error.message}</small>`;
                
                if (window.location.protocol === 'https:') {
                    errorMsg += isEn ? " (Mixed Content check)" : " (HTTPS/HTTP混在の可能性)";
                }
            }
        }
        responseParagraph.innerHTML = `<strong>${isEn ? 'Answer' : '回答'}:</strong> ❌ ${isEn ? 'Error occurred' : 'エラーが発生しました'}: ${errorMsg}`;
        console.error("Model request error:", error);
    } finally {
        sendButton.disabled = false;
        sendButton.textContent = isEn ? 'Send' : '送信';
        // 最新のチャットが見えるようにスクロール
        chatLog.scrollTop = chatLog.scrollHeight;
    }
}

// --- 初期化とイベントリスナー設定 ---
document.addEventListener('DOMContentLoaded', () => {
    loadDocuments(); 
    document.getElementById('sendButton').addEventListener('click', sendToModel);
    document.getElementById('resetDocsButton').addEventListener('click', resetDocuments);
    document.getElementById('saveOcrButton').addEventListener('click', saveOcrTextAsFile);
    document.getElementById('syncFolderButton').addEventListener('click', syncLocalFolder);
    
    // DOMロード後にイベントリスナーを登録 (安全策)
    const pasteArea = document.getElementById('pasteArea');
    if (pasteArea) pasteArea.addEventListener('paste', handlePaste);

    // APIキーのロードと保存処理
    const savedKey = localStorage.getItem('plowerGeminiApiKey');
    if (savedKey) {
        document.getElementById('geminiApiKey').value = savedKey;
    }
    
    const saveKeyBtn = document.getElementById('saveKeyButton');
    saveKeyBtn.addEventListener('click', () => {
        const key = document.getElementById('geminiApiKey').value.trim();
        if (key) {
            localStorage.setItem('plowerGeminiApiKey', key);
            alert(isEn ? 'Gemini API Key saved.' : 'Gemini APIキーを保存しました。次回から自動入力されます。');
        } else {
            alert(isEn ? 'Key is empty. Use "Delete Key" button to remove it.' : 'キーが空です。削除する場合は「キー削除」ボタンを使用してください。');
        }
    });

    // 削除ボタンを動的に追加
    const deleteKeyBtn = document.createElement('button');
    deleteKeyBtn.textContent = isEn ? 'Delete Key' : 'キー削除';
    deleteKeyBtn.style.marginLeft = '5px';
    deleteKeyBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerGeminiApiKey');
        document.getElementById('geminiApiKey').value = '';
        alert(isEn ? 'Gemini API Key deleted.' : '保存されたGemini APIキーを削除しました。');
    });
    saveKeyBtn.parentNode.insertBefore(deleteKeyBtn, saveKeyBtn.nextSibling);
    
    // --- Hugging Face Access Token のロードと保存処理 ---
    const savedHfToken = localStorage.getItem('plowerHfToken');
    if (savedHfToken) {
        document.getElementById('hfToken').value = savedHfToken;
    }

    const saveHfTokenBtn = document.getElementById('saveHfTokenButton');
    if (saveHfTokenBtn) {
        saveHfTokenBtn.addEventListener('click', () => {
            const token = document.getElementById('hfToken').value.trim();
            if (token) {
                localStorage.setItem('plowerHfToken', token);
                alert(isEn ? 'HuggingFace Token saved.' : 'HuggingFaceトークンを保存しました。');
            } else {
                alert(isEn ? 'Token is empty. Use "Delete Token" button to remove it.' : 'トークンが空です。削除する場合は「トークン削除」ボタンを使用してください。');
            }
        });

        // トークン削除ボタンの追加
        const deleteHfTokenBtn = document.createElement('button');
        deleteHfTokenBtn.textContent = isEn ? 'Delete Token' : 'トークン削除';
        deleteHfTokenBtn.style.marginLeft = '5px';
        deleteHfTokenBtn.addEventListener('click', () => {
            localStorage.removeItem('plowerHfToken');
            document.getElementById('hfToken').value = '';
            alert(isEn ? 'HuggingFace Token deleted.' : '保存されたHuggingFaceトークンを削除しました。');
        });
        saveHfTokenBtn.parentNode.insertBefore(deleteHfTokenBtn, saveHfTokenBtn.nextSibling);
    }

    // --- HuggingFace URL設定の初期化とイベントリスナー ---
    const hfUrlInput = document.getElementById('hfUrlInput');
    if (hfUrlInput) {
        hfUrlInput.value = localStorage.getItem('plowerHfUrl') || 'http://localhost:11434';
    }

    const saveHfUrlBtn = document.getElementById('saveHfUrlButton');
    saveHfUrlBtn.addEventListener('click', () => {
        let url = hfUrlInput.value.trim();
        if (!url) url = 'http://localhost:11434';
        let finalMessage = isEn ? 'HuggingFace URL saved.' : 'HuggingFaceのURL設定を保存しました。';
        
        // Hugging Face SpacesのWeb URLが入力された場合、Direct URLに自動変換する
        // 例: https://huggingface.co/spaces/username/spacename -> https://username-spacename.hf.space
        const hfMatch = url.match(/^https?:\/\/huggingface\.co\/spaces\/([^\/]+)\/([^\/]+)\/?$/);
        if (hfMatch) {
            const username = hfMatch[1].toLowerCase();
            const spacename = hfMatch[2].toLowerCase();
            url = `https://${username}-${spacename}.hf.space`;
            hfUrlInput.value = url; // 入力欄も更新
            finalMessage = isEn ? 'Converted Hugging Face Space URL to Direct URL format and saved.' : 'Hugging Face SpaceのWeb URLを検出し、API用のDirect URL形式に自動変換して保存しました。';
        }
        
        localStorage.setItem('plowerHfUrl', url);
        alert(finalMessage);
    });

    // HuggingFace URL削除ボタンを動的に追加
    const deleteHfUrlBtn = document.createElement('button');
    deleteHfUrlBtn.textContent = isEn ? 'Delete URL' : 'URL削除';
    deleteHfUrlBtn.style.marginLeft = '5px';
    deleteHfUrlBtn.addEventListener('click', () => {
        localStorage.removeItem('plowerHfUrl');
        if (hfUrlInput) hfUrlInput.value = 'http://localhost:11434';
        alert(isEn ? 'Saved URL deleted (Reset to default).' : '保存されたURL設定を削除しました（デフォルトのlocalhostに戻りました）。');
    });
    saveHfUrlBtn.parentNode.insertBefore(deleteHfUrlBtn, saveHfUrlBtn.nextSibling);

    // Enterキーでの送信機能
    document.getElementById('userInput').addEventListener('keypress', function(e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendToModel();
        }
    });
});