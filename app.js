/**
 * 設定値: ご自身のSupabaseのURLとAnon Keyを入れてください
 */
const SUPABASE_URL = 'https://ditxmrgfntsndjsmaagg.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XV855Fm-T69rS-8WAUWVTw_96ZJI6A7';

/**
 * 1. API通信クラス (SupabaseのRPC呼び出しを担当)
 */
class DatabaseAPI {
    constructor(url, key) {
        this.url = url;
        this.key = key;
        this.password = null;
    }
    setPassword(password) { this.password = password; }

    async callRpc(rpcName, payload = {}) {
        const body = { p_password: this.password, ...payload };
        const response = await fetch(`${this.url}/rest/v1/rpc/${rpcName}`, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json', 
                'apikey': this.key,
                // ★対象スキーマを明示的に指定（リクエスト用とレスポンス用）
                'Content-Profile': 'mydictionary',
                'Accept-Profile': 'mydictionary'
            },
            body: JSON.stringify(body)
        });
        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.message || 'API Error');
        }
        return response.json();
    }
}

/**
 * 2. Gemini APIクラス (改善版)
 */
class GeminiAPI {
    static API_KEY = null;

    // アプリ起動時に1回だけ呼ばれる初期化処理
    static async init(dbApi) {
        if (this.API_KEY) return; // 取得済みならスキップ
        try {
            // DBからAPIキーを取得してキャッシュ
            this.API_KEY = await dbApi.callRpc('get_app_setting', { p_key: 'gemini_api_key' });
        } catch (e) {
            console.error("Gemini API Key 取得失敗:", e);
        }
    }

    static async search(term) {
        if (!this.API_KEY) {
            return "Gemini APIキーが設定されていないか、取得に失敗しました。";
        }

        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${this.API_KEY}`;
        
        const prompt = `「${term}」という言葉・用語の意味を、国語辞典のように分かりやすく要約してください。
【ルール】
・要約のみを50文字〜100文字程度で出力してください。
・「〜という意味です」などの挨拶や前置き、解説文以外の無駄なテキストは一切出力しないでください。`;

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: prompt }] }]
                })
            });

            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error?.message || "APIエラーが発生しました");
            }

            const data = await response.json();
            const resultText = data.candidates?.[0]?.content?.parts?.[0]?.text;

            return resultText ? resultText.trim() : "意味の取得に失敗しました。";
        } catch (e) {
            console.error("Gemini API Error:", e);
            return "意味を自動取得できませんでした。手動で入力してください。";
        }
    }
}

/**
 * 3. 検索・登録タブ 制御クラス (手動入力・AI取得対応 ＋ 自動重複チェック版)
 */
class SearchController {
    constructor(dbApi) {
        this.dbApi = dbApi;
        this.checkTimer = null; // ★タイマー用の変数を追加
        this.bindEvents();
    }
    
    bindEvents() {
        // ★ボタンクリックではなく、テキスト入力(input)イベントを監視する
        document.getElementById('result-term').addEventListener('input', () => this.handleInput());
        
        document.getElementById('gemini-btn').addEventListener('click', () => this.handleGeminiSearch());
        document.getElementById('save-btn').addEventListener('click', () => this.handleSave());
        document.getElementById('clear-btn').addEventListener('click', () => this.reset());
    }

    async initKinds(kinds) {
        const select = document.getElementById('result-kind');
        select.innerHTML = kinds.map(k => `<option value="${k.kind_id}">${k.kind_name}</option>`).join('');
    }

    // ★入力のたびに呼ばれる処理（ディバウンス）
    handleInput() {
        const term = document.getElementById('result-term').value.trim();
        const msgEl = document.getElementById('status-msg');

        // 前回のタイマーが残っていればキャンセル（連続通信を防止）
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
        }

        // 入力が空になった場合はメッセージを消して終了
        if (!term) {
            msgEl.textContent = "";
            return;
        }

        // 入力中はフィードバックを表示
        msgEl.textContent = "入力待機中...";
        msgEl.style.color = "#6c757d";

        // 入力が止まってから0.6秒(600ミリ秒)後にDBチェックを実行
        this.checkTimer = setTimeout(() => {
            this.handleDbCheck(term);
        }, 600);
    }

    // DBに既に登録されているか確認する機能（引数でtermを受け取るように変更）
    async handleDbCheck(term) {
        const msgEl = document.getElementById('status-msg');
        msgEl.textContent = "確認中...";
        msgEl.style.color = "#17a2b8";

        try {
            const dbCheck = await this.dbApi.callRpc('check_term', { p_term: term }).then(r => r[0]);
            
            if (dbCheck && dbCheck.is_exist) {
                msgEl.textContent = "※既に登録済みです（保存で上書きされます）";
                msgEl.style.color = "orange";
                document.getElementById('result-explanation').value = dbCheck.explanation;
                document.getElementById('result-kind').value = dbCheck.kind_id;
            } else {
                msgEl.textContent = "※未登録の用語です";
                msgEl.style.color = "blue";
            }
        } catch (e) {
            console.error("確認エラー: ", e);
            msgEl.textContent = "通信エラーが発生しました";
            msgEl.style.color = "red";
        }
    }

    // AIで意味を自動取得する機能
    async handleGeminiSearch() {
        const term = document.getElementById('result-term').value.trim();
        if (!term) {
            alert("意味を取得したい用語を入力してください。");
            return;
        }

        const btn = document.getElementById('gemini-btn');
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = "AIで取得中...";

        try {
            const geminiExtract = await GeminiAPI.search(term);
            document.getElementById('result-explanation').value = geminiExtract;
        } catch (e) {
            alert("AI取得エラー: " + e.message);
        } finally {
            btn.textContent = originalText;
            btn.disabled = false;
        }
    }

    async handleSave() {
        const term = document.getElementById('result-term').value.trim();
        const explanation = document.getElementById('result-explanation').value.trim();
        const kindId = document.getElementById('result-kind').value;

        if (!term || !explanation) return alert("用語と意味を入力してください。");

        try {
            document.getElementById('save-btn').disabled = true;
            await this.dbApi.callRpc('save_data', { 
                p_kind_id: parseInt(kindId, 10), 
                p_term: term, 
                p_explanation: explanation 
            });
            alert("保存しました！");
            
            this.reset();
        } catch (e) {
            alert("保存エラー: " + e.message);
        } finally {
            document.getElementById('save-btn').disabled = false;
        }
    }

    // フォームを初期状態に戻す
    reset() {
        // ★リセット時に動作中のタイマーがあれば止める
        if (this.checkTimer) {
            clearTimeout(this.checkTimer);
        }

        document.getElementById('result-term').value = '';
        document.getElementById('result-explanation').value = '';
        document.getElementById('status-msg').textContent = '';
        
        const kindSelect = document.getElementById('result-kind');
        if (kindSelect.options.length > 0) {
            kindSelect.selectedIndex = 0;
        }
    }
}

/**
 * 4. 履歴タブ 制御クラス
 */
class HistoryController {
    constructor(dbApi) {
        this.dbApi = dbApi;
        this.dataList = [];
        this.displayCount = 0;
        this.PAGE_SIZE = 50;
        this.bindEvents();
    }

    bindEvents() {
        document.getElementById('history-kind').addEventListener('change', (e) => this.fetchData(e.target.value));
        document.getElementById('shuffle-btn').addEventListener('click', () => this.shuffleAndRender());
        document.getElementById('load-more-btn').addEventListener('click', () => this.renderNext());
        document.getElementById('history-list').addEventListener('click', (e) => {
            if (e.target.classList.contains('delete-btn')) {
                this.deleteItem(e.target.dataset.term);
            }
        });
    }

    initKinds(kinds) {
        const select = document.getElementById('history-kind');
        select.innerHTML = '<option value="">種別を選択</option>' + 
                           kinds.map(k => `<option value="${k.kind_id}">${k.kind_name}</option>`).join('');
    }

    async fetchData(kindId) {
        if (!kindId) return this.clear();
        
        try {
            // JS側に一括で全件取得して保持する（毎回のAPI通信を減らすため）
            this.dataList = await this.dbApi.callRpc('get_data', { p_kind_id: parseInt(kindId, 10) });
            if (this.dataList.length > 0) {
                document.getElementById('shuffle-btn').classList.remove('hidden');
                this.displayCount = 0;
                document.getElementById('history-list').innerHTML = '';
                this.renderNext();
            } else {
                this.clear();
                document.getElementById('history-list').innerHTML = '<p>データがありません。</p>';
            }
        } catch (e) {
            alert("データ取得エラー: " + e.message);
        }
    }

    shuffleAndRender() {
        // Fisher-Yatesアルゴリズムで配列をシャッフル
        for (let i = this.dataList.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.dataList[i], this.dataList[j]] = [this.dataList[j], this.dataList[i]];
        }
        this.displayCount = 0;
        document.getElementById('history-list').innerHTML = '';
        this.renderNext();
    }

    renderNext() {
        const slice = this.dataList.slice(this.displayCount, this.displayCount + this.PAGE_SIZE);
        const listDiv = document.getElementById('history-list');
        
        slice.forEach(item => {
            const div = document.createElement('div');
            div.className = 'history-item';
            div.innerHTML = `
                <div class="history-term">${this.escapeHTML(item.term)}</div>
                <div class="history-desc">${this.escapeHTML(item.explanation).replace(/\n/g, '<br>')}</div>
                <button class="delete-btn" data-term="${this.escapeHTML(item.term)}">削除</button>
            `;
            listDiv.appendChild(div);
        });

        this.displayCount += slice.length;
        
        const moreBtn = document.getElementById('load-more-btn');
        if (this.displayCount < this.dataList.length) {
            moreBtn.classList.remove('hidden');
        } else {
            moreBtn.classList.add('hidden');
        }
    }

    clear() {
        this.dataList = [];
        document.getElementById('history-list').innerHTML = '';
        document.getElementById('shuffle-btn').classList.add('hidden');
        document.getElementById('load-more-btn').classList.add('hidden');
    }

    deleteItem(term) {
        if (!confirm(`「${term}」を削除しますか？`)) return;

        this.dbApi.callRpc('delete_data', { p_term: term })
            .then(() => {
                alert("削除しました！");
                // 削除後に再取得して表示を更新
                const kindId = document.getElementById('history-kind').value;
                this.fetchData(kindId);
            })
            .catch(e => alert("削除エラー: " + e.message));
    }
    
    escapeHTML(str) {
        return str.replace(/[&<>'"]/g, tag => ({'&': '&amp;','<': '&lt;','>': '&gt;',"'": '&#39;','"': '&quot;'}[tag] || tag));
    }
}

/**
 * 5. アプリケーション統括クラス (改善版)
 */
class App {
    constructor() {
        this.dbApi = new DatabaseAPI(SUPABASE_URL, SUPABASE_KEY);
        this.searchCtrl = new SearchController(this.dbApi);
        this.historyCtrl = new HistoryController(this.dbApi);
        
        this.bindEvents();
    }

    bindEvents() {
        // ログイン処理
        document.getElementById('login-btn').addEventListener('click', async () => {
            const pass = document.getElementById('login-password').value;
            try {
                const isValid = await this.dbApi.callRpc('p_login', { p_password: pass }).then(r => r);
                if (isValid) {
                    this.dbApi.setPassword(pass);
                    document.getElementById('login-screen').classList.add('hidden');
                    document.getElementById('main-screen').classList.remove('hidden');
                    this.initApp(); // ログイン成功後に初期化
                } else {
                    alert("パスワードが違います");
                }
            } catch (e) {
                alert("通信エラー");
            }
        });

        // タブ切り替え処理
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
                
                e.target.classList.add('active');
                document.getElementById(e.target.dataset.target).classList.add('active');
            });
        });
    }

    async initApp() {
        try {
            // 初期化時に「種別データ」と「Gemini APIキー」を並行して事前ロード
            const [kinds] = await Promise.all([
                this.dbApi.callRpc('get_kinds'),
                GeminiAPI.init(this.dbApi)
            ]);
            
            this.searchCtrl.initKinds(kinds);
            this.historyCtrl.initKinds(kinds);
        } catch (e) {
            alert("初期データの読み込みに失敗しました。");
        }
    }
}

// 起動
document.addEventListener('DOMContentLoaded', () => new App());