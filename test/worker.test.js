import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { adminStats } from "../src/index.js";
import { extractOfficeText } from "../src/office.js";
import { routeFromScore } from "../src/routing.js";
import { MODEL_PROVIDER_IDS } from "../src/models.js";
import { strToU8, zipSync } from "fflate";

const env = {
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) },
};

test("health 明確標示純 Cloudflare、未使用 GCP", async () => {
  const response = await worker.fetch(new Request("https://example.com/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", runtime: "cloudflare-native", gcp: false });
  assert.equal(response.headers.get("x-ntpu-edge"), "cloudflare-native");
});

test("模型候選與原版 aintpu/aintpu 相同", async () => {
  const response = await worker.fetch(new Request("https://example.com/models"), env);
  const body = await response.json();
  assert.deepEqual(body.candidates.small, ["cloud-small-claude","cloud-small-gemini"]);
  assert.deepEqual(body.candidates.medium, ["cloud-medium-claude","cloud-medium-gemini"]);
  assert.deepEqual(body.candidates.large, ["cloud-large-claude","cloud-large-gemini"]);
  assert.equal(body.judge_model, "judge-model");
});

test("Judge 沿用原版 small / medium / large 難度門檻", () => {
  const config = { threshold_medium:4, threshold_large:7, threshold_tiny:null };
  assert.equal(routeFromScore(config, 3), "small");
  assert.equal(routeFromScore(config, 4), "medium");
  assert.equal(routeFromScore(config, 7), "large");
});

test("OpenRouter provider model ID 與原版 LiteLLM 設定一致", () => {
  assert.equal(MODEL_PROVIDER_IDS["judge-model"], "mistralai/mistral-small-2603");
  assert.equal(MODEL_PROVIDER_IDS["memory-model"], "google/gemini-2.5-flash");
  assert.equal(MODEL_PROVIDER_IDS["cloud-small-claude"], "anthropic/claude-haiku-4.5");
  assert.equal(MODEL_PROVIDER_IDS["cloud-large-gemini"], "google/gemini-2.5-pro");
});

test("回答標籤顯示實際模型名稱，不以 NTPU AI 取代", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.match(html, /short: "Haiku"/);
  assert.match(html, /short: "Gemini Flash-Lite"/);
  assert.doesNotMatch(html, /"gpt-5\.6-luna": \{ cls: "default", short: "NTPU AI"/);
});

test("一般路徑由 Static Assets 提供", async () => {
  const response = await worker.fetch(new Request("https://example.com/about"), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /doctype html/i);
});

test("/about/ 固定提供獨立 about.html", async () => {
  let assetPath = "";
  const routeEnv = { ASSETS: { fetch: async request => { assetPath = new URL(request.url).pathname; return new Response("<!doctype html><title>About</title>"); } } };
  const response = await worker.fetch(new Request("https://ai.ntpu.ai/about/"), routeEnv);
  assert.equal(response.status, 200);
  assert.equal(assetPath, "/about.html");
});

test("新訪客統計直接記錄原始 ID，不雜湊或加密", async () => {
  const [chat, index] = await Promise.all([readFile("src/chat.js", "utf8"), readFile("src/index.js", "utf8")]);
  assert.match(chat, /statsUid: `guest:\$\{guestId\}`/);
  assert.doesNotMatch(chat, /sha256\(guestId\)|aesEncrypt\(guestId/);
  assert.match(index, /const stats=u\?\.uid \|\| `guest:\$\{guest\}`/);
});

test("原 Cloud Run 網址與 Firebase SDK 已移除", async () => {
  const files = await Promise.all([readFile("src/index.js", "utf8"), readFile("wrangler.jsonc", "utf8"), readFile("public/index.html", "utf8")]);
  const joined = files.join("\n");
  assert.doesNotMatch(joined, /run\.app|firebase-app-compat|firebase-auth-compat|BACKEND_ORIGIN/);
});

test("管理統計維持原版 users/by_model/satisfaction/feedback 格式", async () => {
  const usage = [1,2,3].map(i => ({ stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s1",access_type:"guest",model:"cloud-small-claude",route:"small",input_tokens:10,output_tokens:5,created_at:`2026-08-11T00:00:0${i}Z` }));
  usage.push({ stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s2",access_type:"guest",model:"cloud-small-claude",route:"small",input_tokens:10,output_tokens:5,created_at:"2026-08-11T00:00:04Z" });
  const feedback = [{ stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s1",rating:5,is_guest:1,question_count:3,created_at:"2026-08-11T00:01:00Z" }];
  const fakeEnv = { DB: { prepare: sql => ({ bind: () => ({ sql }) }), batch: async () => [{ results: usage }, { results: feedback }] } };
  const data = await adminStats(fakeEnv, new URL("https://example.com/admin/stats"));
  assert.equal(data.users[0].total, 4);
  assert.equal(data.users[0].conversations, 2);
  assert.equal(data.by_model[0].input_tokens, 40);
  assert.equal(data.by_model[0].provider_model, "anthropic/claude-haiku-4.5");
  assert.equal(data.by_model[0].estimated_cost_usd, 0.00014);
  assert.equal(data.token_usage.estimated_cost_usd, 0.00014);
  assert.equal(data.token_usage.pricing_source, "https://openrouter.ai/api/v1/models");
  assert.deepEqual(data.satisfaction, { responses:1, average:5, csat_percent:100, response_rate:100, distribution:{"1":0,"2":0,"3":0,"4":0,"5":1} });
  assert.equal(data.feedback[0].question_count, 3);
});

test("管理統計彙整每則回答的讚／倒讚與原因", async () => {
  const messages = [
    { stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s1",answer_index:0,vote:"up",reasons:"[]",comment:"",is_guest:1,model:"cloud-small-claude",route:"small",created_at:"2026-08-11T00:02:00Z" },
    { stats_uid:"u_a",email:"a@gm.ntpu.edu.tw",session_id:"s3",answer_index:1,vote:"down",reasons:'["slow","wrong","outdated"]',comment:"規定已經改了",is_guest:0,model:"cloud-small-claude",route:"small",elapsed_ms:42000,created_at:"2026-08-11T00:03:00Z" },
  ];
  const fakeEnv = { DB: { prepare: sql => ({ bind: () => ({ sql }) }), batch: async () => [{ results: [] }, { results: [] }, { results: messages }] } };
  const data = await adminStats(fakeEnv, new URL("https://example.com/admin/stats"));
  assert.equal(data.message_feedback.total, 2);
  assert.equal(data.message_feedback.up, 1);
  assert.equal(data.message_feedback.down, 1);
  assert.equal(data.message_feedback.positive_percent, 50);
  assert.equal(data.message_feedback.reasons.wrong, 1);
  assert.equal(data.message_feedback.slow_reports, 1);
  assert.equal(data.message_feedback.slow_avg_ms, 42000);
  assert.equal(data.message_feedback.reasons.outdated, 1);
  assert.equal(data.message_feedback.by_model[0].model, "cloud-small-claude");
  assert.equal(data.message_feedback.comments.length, 1);
  assert.equal(data.message_feedback.comments[0].comment, "規定已經改了");
});

test("每則回答都有讚／倒讚，倒讚可填原因", async () => {
  const [html, index] = await Promise.all([readFile("public/index.html", "utf8"), readFile("src/index.js", "utf8")]);
  assert.match(html, /class="fb-btn fb-up/);
  assert.match(html, /class="fb-btn fb-down/);
  assert.match(html, /_feedbackPanelHtml/);
  assert.match(index, /INSERT INTO message_feedback/);
  assert.match(index, /vote 只能是 up 或 down/);
});

test("管理面板分開 Session 回饋與 Token 費用", async () => {
  const [html, index, models] = await Promise.all([
    readFile("public/index.html", "utf8"),
    readFile("src/index.js", "utf8"),
    readFile("src/models.js", "utf8"),
  ]);
  assert.match(html, /data-stats-view="sessions"/);
  assert.match(html, /data-stats-view="tokens"/);
  assert.match(html, /statsTokenCost/);
  assert.match(index, /estimated_cost_usd/);
  assert.match(models, /OPENROUTER_PRICING/);
});

test("搜尋按鈕不出現在附件選單，三題後才顯示滿意度問卷", async () => {
  const html = await readFile("public/index.html", "utf8");
  assert.doesNotMatch(html, /id="menuSearchItem"/);
  assert.doesNotMatch(html, /id="menuNtpuItem"/);
  assert.match(html, /sessionQuestionCount < 3/);
});

test("Cloudflare 可直接擷取 DOCX 文字供預覽與模型使用", () => {
  const bytes = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>國立臺北大學</w:t></w:r></w:p></w:body></w:document>') });
  assert.equal(extractOfficeText(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "國立臺北大學");
});
