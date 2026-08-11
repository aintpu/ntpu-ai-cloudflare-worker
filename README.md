# NTPU AI — Cloudflare Worker 版

這是與 GCP 主專案完全分離的 Cloudflare Worker 專案：

- Cloudflare Static Assets 提供 `public/index.html`。
- Worker 將允許清單內的 API 路徑反向代理至既有 GCP Cloud Run Router。
- FastAPI、Firebase、Firestore、GCS、LiteLLM 與模型仍留在 GCP，不搬進 Worker。
- 瀏覽器只呼叫同源 Worker，因此不需要為 API 放寬跨網域 CORS。

```text
瀏覽器
  ├─ /、靜態內容 ──> Cloudflare Static Assets
  └─ /models、/chat/*、/admin/* ...
                      └─> Cloudflare Worker
                            └─> GCP Cloud Run Router
                                  └─> LiteLLM / 模型、Firestore、GCS
```

## 本機使用

需要 Node.js 20 以上：

```powershell
npm install
npm test
npm run deploy:check
npm run dev
```

## 部署

第一次使用先登入：

```powershell
npx wrangler login
npm run deploy
```

預設 Worker 名稱是 `ntpu-ai-cloudflare-worker`，測試網址會是：

```text
https://ntpu-ai-cloudflare-worker.<Cloudflare 帳號子網域>.workers.dev
```

部署後至少確認：

```text
GET /health  -> 200, {"status":"ok"}
GET /models  -> 200
POST /chat/stream -> SSE 串流
```

## Firebase Email Link

若要在 `workers.dev` 網址測試登入，必須到 Firebase Console → Authentication →
Settings → Authorized domains，加入完整 hostname，例如：

```text
ntpu-ai-cloudflare-worker.aintpu.workers.dev
```

只測試訪客聊天時不需要這一步。

## 正式網域注意事項

在 Worker 版完整驗證前，不要把 `ai.ntpu.ai` 從現有 Cloud Run 切走。確認登入、聊天、
附件、搜尋、管理員與串流全部正常後，再規劃 Cloudflare Route 或自訂網域切換。

## 安全設計

- 只代理明確列出的 API 路徑，不能把 Worker 當任意 URL proxy。
- `BACKEND_ORIGIN` 必須是 HTTPS。
- 不主動轉送 `CF-Connecting-IP`、`CF-IPCountry`、`CF-Ray` 等訪客網路識別標頭。
- 保留 Authorization 與串流 body，Firebase Token、上傳與 SSE 可正常穿透。
- 靜態頁面由 Worker 加上 CSP、HSTS、X-Frame-Options 等安全回應標頭。
- Secret 不得放入 Git、`wrangler.jsonc` 或前端；需要時使用 `wrangler secret put`。
