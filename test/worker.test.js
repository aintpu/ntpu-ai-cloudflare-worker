import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker, { adminStats } from "../src/index.js";
import { extractOfficeText } from "../src/office.js";
import { aesDecrypt, aesEncrypt } from "../src/utils.js";
import { strToU8, zipSync } from "fflate";

const env = {
  OPENAI_MODEL: "gpt-5.6-luna",
  ASSETS: { fetch: async () => new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) },
};

test("health 明確標示純 Cloudflare、未使用 GCP", async () => {
  const response = await worker.fetch(new Request("https://example.com/health"), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", runtime: "cloudflare-native", gcp: false });
  assert.equal(response.headers.get("x-ntpu-edge"), "cloudflare-native");
});

test("models 只公開單一預設模型", async () => {
  const response = await worker.fetch(new Request("https://example.com/models"), env);
  const body = await response.json();
  assert.deepEqual(body.candidates.default, ["gpt-5.6-luna"]);
});

test("一般路徑由 Static Assets 提供", async () => {
  const response = await worker.fetch(new Request("https://example.com/about"), env);
  assert.equal(response.status, 200);
  assert.match(await response.text(), /doctype html/i);
});

test("訪客識別碼可用 AES-GCM 還原", async () => {
  const encrypted = await aesEncrypt("00112233445566778899aabbccddeeff", "test-secret", "guest:test");
  assert.equal(await aesDecrypt(encrypted, "test-secret", "guest:test"), "00112233445566778899aabbccddeeff");
});

test("原 Cloud Run 網址與 Firebase SDK 已移除", async () => {
  const files = await Promise.all([readFile("src/index.js", "utf8"), readFile("wrangler.jsonc", "utf8"), readFile("public/index.html", "utf8")]);
  const joined = files.join("\n");
  assert.doesNotMatch(joined, /run\.app|firebase-app-compat|firebase-auth-compat|BACKEND_ORIGIN/);
});

test("管理統計維持原版 users/by_model/satisfaction/feedback 格式", async () => {
  const usage = [1,2,3].map(i => ({ stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s1",access_type:"guest",model:"gpt-5.6-luna",route:"default",input_tokens:10,output_tokens:5,created_at:`2026-08-11T00:00:0${i}Z` }));
  const feedback = [{ stats_uid:"guest:abcdefghijklmnop",email:"",session_id:"s1",rating:5,is_guest:1,question_count:3,created_at:"2026-08-11T00:01:00Z" }];
  const fakeEnv = { DB: { prepare: sql => ({ bind: () => ({ sql }) }), batch: async () => [{ results: usage }, { results: feedback }] } };
  const data = await adminStats(fakeEnv, new URL("https://example.com/admin/stats"));
  assert.equal(data.users[0].total, 3);
  assert.equal(data.users[0].conversations, 1);
  assert.equal(data.by_model[0].input_tokens, 30);
  assert.deepEqual(data.satisfaction, { responses:1, average:5, csat_percent:100, response_rate:100, distribution:{"1":0,"2":0,"3":0,"4":0,"5":1} });
  assert.equal(data.feedback[0].question_count, 3);
});

test("Cloudflare 可直接擷取 DOCX 文字供預覽與模型使用", () => {
  const bytes = zipSync({ "word/document.xml": strToU8('<w:document><w:body><w:p><w:r><w:t>國立臺北大學</w:t></w:r></w:p></w:body></w:document>') });
  assert.equal(extractOfficeText(bytes, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), "國立臺北大學");
});
