# 121 雲端寫入設定

這個 Worker 讓公開的 121 頁面安全地更新 `data/121-log.md`。GitHub Token 只存於 Cloudflare 的私密變數，不會出現在網站或 GitHub Pages。

## 1. 建立 Cloudflare Worker

1. 登入 Cloudflare Dashboard，開啟 **Workers & Pages**。
2. 點 **Create application** → **Create Worker**。
3. 名稱填 `pt-d-proposal`，建立後開啟編輯器。
4. 將 `worker.js` 全部內容貼上並部署。
5. 部署完成後複製 Worker 網址，格式類似 `https://pt-d-proposal.<你的帳號>.workers.dev`。

## 2. 設定公開變數

在 Worker 的 **Settings → Variables and Secrets** 加入以下文字變數：

| 名稱 | 值 |
| --- | --- |
| `GITHUB_OWNER` | `yitsenliu` |
| `GITHUB_REPO` | `pt-d-proposal` |
| `GITHUB_BRANCH` | `main` |
| `LOG_PATH` | `data/121-log.md` |
| `ALLOWED_ORIGIN` | `https://yitsenliu.github.io` |

若 GitHub 帳號名稱或 repository 名稱不同，請改成你的實際資料。`ALLOWED_ORIGIN` 只填網域，不包含 `/pt-d-proposal/`。

## 3. 建立 GitHub 寫入權限

1. GitHub 右上角頭像 → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens**。
2. 建立新 Token，Repository access 選 **Only select repositories**，只勾選 `pt-d-proposal`。
3. Repository permissions 的 **Contents** 選 **Read and write**；其他權限保持不開啟。
4. 複製 Token。它只會顯示一次。
5. 回到 Cloudflare Worker 的 **Variables and Secrets**，新增 Secret：`GITHUB_TOKEN`，貼上 Token。

## 4. 建立人機驗證

1. 在 Cloudflare Dashboard 開啟 **Turnstile**，新增 Widget。
2. Domain 填 `yitsenliu.github.io`。
3. 複製 Site Key 與 Secret Key。
4. Worker 的 **Variables and Secrets** 新增 Secret：`TURNSTILE_SECRET`，填入 Secret Key。
5. 開啟 `assets/121-config.js`，填入 Worker 網址與 Site Key：

```js
window.PTD121_CONFIG = {
  workerUrl: "https://pt-d-proposal.<你的帳號>.workers.dev/api/update",
  turnstileSiteKey: "你的 Site Key"
};
```

6. 將更新後的 `assets/121-config.js` 上傳到 GitHub repository。

## 5. 測試

開啟 `https://yitsenliu.github.io/pt-d-proposal/121.html`，選擇修改人、主成員與至少一位夥伴，完成驗證後確認送出。幾秒後重新整理，最新紀錄會顯示在頁面，並同步寫入 repository 的 `data/121-log.md`。

若送出時看到 `服務尚未設定完成`，代表 Cloudflare Worker 的 Variables and Secrets 尚未設定完整。至少需要 `GITHUB_OWNER`、`GITHUB_REPO`、`GITHUB_TOKEN`、`ALLOWED_ORIGIN`、`TURNSTILE_SECRET`；其中 `GITHUB_TOKEN` 要有該 repository 的 Contents: Read and write 權限。

## 風險界線

頁面是公開的，任何通過人機驗證的訪客都能提交完成紀錄。Worker 會限制欄位、阻擋非本站來源並只覆寫同組的舊紀錄，但無法確認下拉選單中的姓名是否是真實本人。若日後需要確認身分，應改成 GitHub 登入或其他帳號驗證。


## 請求與上游防護

儲存維持 GitHub Contents API，寫入 `data/121-log.md`，保留 SHA 競爭更新與最多三次 409 重試；無 D1 或資料搬遷。前端公開讀取仍直接載入 GitHub Pages 的 `data/121-log.md` 與 `data/members.json`，Worker 只提供 `POST /api/update` 與預檢，未知路徑回 404。

POST 僅接受未壓縮的 `application/json`，從實際串流 bytes 限制 16 KiB，忽略不可信的 Content-Length；超量回 413，JSON 或物件格式錯誤回 400，讀取超過 5 秒回 408。原有成員名單、同人排除、備註長度與 honeypot 驗證保留；未通過輸入驗證不呼叫 GitHub 或 Turnstile。

Turnstile 必須回傳 `success === true`，且 hostname 與 `ALLOWED_ORIGIN` 的 hostname 相符。既有前端 widget 未設定 action，因此此版不強制要求 action。驗證 token 最多 2,048 字元。Turnstile 與每次 GitHub 呼叫各有涵蓋 headers／body 的 5 秒期限、實際上游回應上限 2 MiB，禁止自動跟隨 redirect。驗證失敗回 400；上游失敗僅回通用訊息，不回傳 GitHub body、token、例外細節或 secret 變數名稱。

本機測試（不使用真實 token、不呼叫線上服務）：

```sh
node --test test/worker.test.mjs
```

測試以真正 Worker fetch handler 搭配 mocked GitHub／Turnstile 驗證；仍須部署後確認正式 Worker runtime 與既有設定。此修改未變更 `wrangler.toml` 的 vars 或 bindings。
