import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import worker from "../src/index.js";
import { aesDecrypt, aesEncrypt } from "../src/utils.js";

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
