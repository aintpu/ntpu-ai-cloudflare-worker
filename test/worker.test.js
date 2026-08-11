import assert from "node:assert/strict";
import test from "node:test";

import { handleRequest, isApiPath } from "../src/index.js";

const env = {
  BACKEND_ORIGIN: "https://backend.example.test",
  ASSETS: {
    async fetch() {
      return new Response("<h1>NTPU AI</h1>", {
        headers: { "Content-Type": "text/html" },
      });
    },
  },
};

test("辨識所有主要 API 路徑，不把一般靜態路徑送往後端", () => {
  for (const path of [
    "/health", "/models", "/chat/stream", "/feedback/session", "/conversations",
    "/conversations/s-1", "/share/abc", "/user/profile", "/admin/stats",
    "/upload", "/file-preview?path=x", "/transcribe",
  ]) {
    assert.equal(isApiPath(new URL(path, "https://worker.test").pathname), true, path);
  }
  assert.equal(isApiPath("/"), false);
  assert.equal(isApiPath("/assets/app.js"), false);
  assert.equal(isApiPath("/administrator"), false);
});

test("API 請求代理到固定 HTTPS 後端並保留路徑、查詢與授權", async () => {
  let received;
  const response = await handleRequest(
    new Request("https://worker.test/models?lang=zh", {
      headers: { Authorization: "Bearer test-token", "CF-Connecting-IP": "192.0.2.1" },
    }),
    env,
    async (request) => {
      received = request;
      return Response.json({ ok: true });
    },
  );
  assert.equal(received.url, "https://backend.example.test/models?lang=zh");
  assert.equal(received.headers.get("Authorization"), "Bearer test-token");
  assert.equal(received.headers.get("CF-Connecting-IP"), null);
  assert.equal(received.headers.get("X-Forwarded-Host"), "worker.test");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-NTPU-Edge"), "cloudflare-worker");
});

test("POST body 與串流回應可穿透代理", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "hello" }),
    }),
    env,
    async (request) => {
      assert.deepEqual(await request.json(), { message: "hello" });
      return new Response("data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
    },
  );
  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(await response.text(), "data: [DONE]\n\n");
});

test("前端由 Static Assets 提供並附加安全標頭", async () => {
  const response = await handleRequest(new Request("https://worker.test/"), env, async () => {
    throw new Error("不應呼叫外部 fetch");
  });
  assert.equal(response.status, 200);
  assert.match(await response.text(), /NTPU AI/);
  assert.equal(response.headers.get("X-Frame-Options"), "DENY");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
});

test("後端連線失敗時回傳不洩漏內部資訊的 502", async () => {
  const response = await handleRequest(
    new Request("https://worker.test/models"),
    env,
    async () => { throw new Error("secret internal detail"); },
  );
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret internal detail/);
});
