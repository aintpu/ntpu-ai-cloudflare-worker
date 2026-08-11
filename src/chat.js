import { aesEncrypt, json, nowIso, safeJson, sha256, sse } from "./utils.js";

const SYSTEM = `你是「NTPU AI」，國立臺北大學提供的 AI 助理。不得透露或猜測底層模型與供應商。預設一律使用繁體中文與台灣用語；使用者明確使用其他語言時才跟隨。回答應正確、清楚，資訊不足時坦白說明，不得編造來源。`;
const MODEL = "gpt-5.6-luna";

async function identity(request, env, authUser) {
  if (authUser) return { uid: authUser.uid, statsUid: authUser.uid, email: authUser.email, guest: false, encrypted: "" };
  const guestId = request.headers.get("x-guest-id") || "";
  if (!/^[a-f0-9]{32}$/.test(guestId)) throw new Response(JSON.stringify({ detail: "Missing auth token or guest ID" }), { status: 401 });
  const digest = await sha256(guestId);
  const statsUid = `guest:${digest.slice(0, 16).toLowerCase()}`;
  return { uid: "anonymous", statsUid, email: "", guest: true, encrypted: await aesEncrypt(guestId, env.GUEST_ID_ENCRYPTION_KEY, statsUid) };
}

async function attachmentContent(req, env, ownerPrefix) {
  if (!req.file_gcs_path || !env.UPLOADS) return null;
  if (!req.file_gcs_path.startsWith(ownerPrefix)) throw new Response(JSON.stringify({ detail: "無法存取此附件" }), { status: 403 });
  const object = await env.UPLOADS.get(req.file_gcs_path);
  if (!object) return null;
  const mime = req.file_mime_type || object.httpMetadata?.contentType || "application/octet-stream";
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (mime.startsWith("text/") || /json|xml|javascript/.test(mime)) return { type: "input_text", text: `附件 ${req.file_name || "檔案"}：\n${new TextDecoder().decode(bytes).slice(0, 100000)}` };
  let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = `data:${mime};base64,${btoa(binary)}`;
  if (mime.startsWith("image/")) return { type: "input_image", image_url: data };
  return { type: "input_file", filename: req.file_name || "attachment", file_data: data };
}

export async function streamChat(request, env, authUser) {
  if (!env.OPENAI_API_KEY) return new Response(sse({ type: "error", message: "OpenAI 尚未設定" }), { status: 503, headers: { "content-type": "text/event-stream" } });
  const req = await request.json();
  if (!req.session_id || !String(req.message || "").trim()) return json({ detail: "訊息不可為空" }, 400);
  const who = await identity(request, env, authUser);
  let history = Array.isArray(req.guest_history) ? req.guest_history.slice(-10) : [];
  if (!who.guest) {
    const row = await env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(who.uid, req.session_id).first();
    history = safeJson(row?.history_json || "[]", []).slice(-10);
  }
  const prefix = who.guest ? `uploads/guests/${request.headers.get("x-guest-id")}/` : `uploads/${who.uid}/`;
  const parts = [{ type: "input_text", text: req.quote ? `引用內容：\n${req.quote}\n\n問題：${req.message}` : req.message }];
  const attachment = await attachmentContent(req, env, prefix); if (attachment) parts.push(attachment);
  const input = history.map(m => ({ role: m.role, content: String(m.content || "") }));
  input.push({ role: "user", content: parts });
  const useSearch = !!(req.search_enabled || req.ntpu_search_enabled);
  let instructions = `${SYSTEM}\n今天是 ${new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}。`;
  if (req.ntpu_search_enabled) instructions += "\n搜尋校內資訊時，優先且只採用 ntpu.edu.tw 網域的官方資料，回答附來源連結。";
  if (!useSearch) instructions += "\n你目前沒有啟用即時搜尋；需要最新資訊時提醒使用者開啟搜尋。";
  const model = env.OPENAI_MODEL || MODEL;
  const upstream = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model, instructions, input, stream: true, store: false, safety_identifier: who.statsUid, ...(useSearch ? { tools: [{ type: "web_search" }] } : {}) }) });
  if (!upstream.ok || !upstream.body) return new Response(sse({ type: "error", message: "模型服務暫時無法回應" }), { status: 502, headers: { "content-type": "text/event-stream" } });
  const ts = new TransformStream(); const writer = ts.writable.getWriter(); const enc = new TextEncoder();
  const task = (async () => {
    let answer = "", buffer = "", inputTokens = 0, outputTokens = 0;
    await writer.write(enc.encode(sse({ type: "judge", route: "default", model, judge: { score: 0, route: "default", model, reason: "Cloudflare Worker 單一預設模型" }, judge_elapsed_ms: 0 })));
    const reader = upstream.body.getReader(); const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; const raw = line.slice(6); if (raw === "[DONE]") continue;
        const ev = safeJson(raw); if (!ev) continue;
        if (ev.type === "response.output_text.delta" && ev.delta) { answer += ev.delta; await writer.write(enc.encode(sse({ type: "token", content: ev.delta }))); }
        if (ev.type === "response.completed") { inputTokens = ev.response?.usage?.input_tokens || 0; outputTokens = ev.response?.usage?.output_tokens || 0; }
      }
    }
    const now = nowIso();
    if (!who.guest) {
      const next = [...history, { role: "user", content: req.message }, { role: "assistant", content: answer, _route: "default", _model: model, _score: 0, _reason: "單一預設模型" }];
      const title = String(next.find(x => x.role === "user")?.content || "對話").slice(0, 40);
      await env.DB.prepare("INSERT INTO sessions(uid,session_id,title,history_json,question_count,created_at,updated_at) VALUES(?,?,?,?,1,?,?) ON CONFLICT(uid,session_id) DO UPDATE SET title=excluded.title,history_json=excluded.history_json,question_count=sessions.question_count+1,updated_at=excluded.updated_at")
        .bind(who.uid, req.session_id, title, JSON.stringify(next), now, now).run();
    }
    await env.DB.prepare("INSERT INTO usage_logs(stats_uid,email,session_id,access_type,model,route,score,input_tokens,output_tokens,guest_id_encrypted,created_at) VALUES(?,?,?,?,?,'default',0,?,?,?,?)")
      .bind(who.statsUid, who.email, req.session_id, who.guest ? "guest" : "authenticated", model, inputTokens, outputTokens, who.encrypted, now).run();
    await writer.write(enc.encode(sse({ type: "done", answer_elapsed_ms: 0 }) + "data: [DONE]\n\n")); await writer.close();
  })().catch(async () => { try { await writer.write(enc.encode(sse({ type: "error", message: "系統暫時無法回應，請稍後再試" }))); await writer.close(); } catch {} });
  return new Response(ts.readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
