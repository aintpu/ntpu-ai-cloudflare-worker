# NTPU AI — Cloudflare 原生版

這是與原 GCP 專案完全分離的版本。網站執行環境、API、資料與附件皆在 Cloudflare，只有模型推論及語音辨識直接呼叫 OpenAI API。

```text
瀏覽器 → Cloudflare Worker
          ├─ Static Assets：前端
          ├─ D1：帳號、對話、統計、回饋、分享
          ├─ R2：使用者附件
          ├─ Email Service：Magic Link 登入信
          └─ OpenAI API：回答、Web Search、語音辨識
```

本專案不含 Cloud Run、Firebase、Firestore、GCS、LiteLLM 或 OpenRouter。

## Cloudflare 資源

- Worker：`ntpu-ai-cloudflare-worker`
- D1：`ntpu-ai-worker-db`
- R2：`ntpu-ai-worker-uploads`
- 網址：<https://ntpu-ai-cloudflare-worker.aintpu.workers.dev>

## 本機檢查與部署

```powershell
npm install
npm run check
npx wrangler d1 migrations apply ntpu-ai-worker-db --remote
npm run deploy
```

## 必要 Secrets

以下值只透過 `wrangler secret put` 設定，不得寫入 Git：

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put AUTH_SECRET
npx wrangler secret put GUEST_ID_ENCRYPTION_KEY
```

## Email Magic Link

登入不使用 Firebase。需先在 Cloudflare Email Service onboard `ntpu.ai`，完成 SPF、DKIM 等 DNS 驗證，再於 `wrangler.jsonc` 加入 `EMAIL` send binding。寄件者預設為 `NTPU AI <noreply@ntpu.ai>`，登入連結單次有效 15 分鐘。

允許申請帳號的網域：

- `gm.ntpu.edu.tw`
- `ms.ntpu.edu.tw`
- `mail.ntpu.edu.tw`
- 固定管理員：`aintpu@gmail.com`

## 資料政策

- 登入者對話儲存在 D1。
- 訪客對話文字只留在瀏覽器，不寫入 D1。
- 訪客統計使用假名 ID；原始訪客 ID 以 AES-GCM 加密後保存，可由管理員按需還原。
- 附件按登入 UID 或訪客 ID 分隔存放於 R2，預覽 API 會檢查所有權。

## 正式網域

此版本尚未接管 `ai.ntpu.ai`；原 GCP 正式站不受影響。所有登入、附件、搜尋與管理功能驗證完成後，再決定是否切換自訂網域。
