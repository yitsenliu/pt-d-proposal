# 商用不動產升級鏈｜提案網站

這是一個純靜態、零外部依賴的響應式網站，可直接發布到 GitHub Pages。

## 發布到 GitHub Pages

1. 在 GitHub 建立一個新的 repository。
2. 上傳本資料夾中的 `index.html`、`121.html`、`assets`、`data`、`robots.txt`、`404.html`、`SHA256SUMS.txt` 與 `cloudflare-worker`。
3. 進入 repository 的 **Settings → Pages**。
4. 在 **Build and deployment** 選擇 **Deploy from a branch**。
5. Branch 選 `main`，資料夾選 `/ (root)`，儲存後等待 GitHub 產生網址。

## 建議的帳號與發布防護

- GitHub 帳號開啟雙因素驗證，使用獨立強密碼或 passkey。
- Repository 不要放 Word 原稿、試算表、逐字稿、聯絡資料、金鑰或 `.env`。
- 僅給必要成員寫入權限；其餘成員只分享 Pages 網址。
- 在 Branch protection rules 保護 `main`，要求 Pull Request 與核准後才能合併。
- 每次發布前執行雜湊檢查，確認檔案未被非預期改動。
- 若內容不能公開，請不要使用公開 GitHub Pages；改用具登入驗證的私人入口。

## 隱私與安全設計

- 交流版保留 12 位成員姓名、專業角色與代表公司，以支援引薦及協作；不含電話、Email、地址或帳號等聯絡資訊。
- 提案首頁不含追蹤碼或第三方程式；121 頁面僅在設定人機驗證後載入 Cloudflare Turnstile。
- GitHub 寫入權限不會放在網頁；僅由 Cloudflare Worker 的私密設定使用。
- Content Security Policy 預設拒絕不必要內容，121 頁面僅允許本站、Worker 與人機驗證連線。
- 禁用相機、麥克風、定位、付款與 USB 等瀏覽器權限。
- 搜尋引擎設定為不索引；但這不是存取控制，知道網址的人仍可開啟。

## 重要限制

任何公開網址都無法保證「只有成員能看」，也無法阻止瀏覽者截圖或轉傳。GitHub Pages 適合公開或可被轉傳的內容；若提案含機密、報價、聯絡資料或客戶資料，應使用具帳號登入、權限控管與存取紀錄的服務。

## 121 雲端紀錄

`121.html` 讓成員批次登錄完成的 121；同一組成員的紀錄以最新送出資料為準，寫入 `data/121-log.md`。網站頁面不能安全保存 GitHub 寫入權限，因此需部署 `cloudflare-worker`，並把 Worker 網址與 Turnstile Site Key 填入 `assets/121-config.js`。完整設定步驟見 `cloudflare-worker/README.md`。
