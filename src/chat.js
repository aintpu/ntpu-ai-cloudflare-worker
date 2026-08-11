import { aesEncrypt, json, nowIso, safeJson, sha256, sse } from "./utils.js";
import { extractOfficeText, OFFICE_MIMES } from "./office.js";
import { classifyDifficulty, loadRoutingConfig } from "./routing.js";

const SYSTEM = `你是「NTPU AI」，國立臺北大學提供的 AI 助理。不得透露或猜測底層模型與供應商。預設一律使用繁體中文與台灣用語；使用者明確使用其他語言時才跟隨。回答應正確、清楚，資訊不足時坦白說明，不得編造來源。`;
const MODEL = "gpt-5.6-luna";
const MEMORY_PROMPT = `你是使用者的長期記憶維護員。把既有摘要與最近對話合併，只保留跨對話仍有用的身份、偏好、長期專案與目標；新資訊與舊摘要衝突時以新的為準。不要逐輪覆述，最多 2000 字。只輸出摘要純文字。`;

function responseText(data) {
  if (data.output_text) return data.output_text;
  return (data.output || []).flatMap(x => x.content || []).filter(x => x.type === "output_text").map(x => x.text || "").join("");
}

export async function compressMemory(env, uid, sessionId, suppliedHistory = null) {
  const [session, profile] = await Promise.all([
    suppliedHistory ? Promise.resolve(null) : env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(uid, sessionId).first(),
    env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(uid).first(),
  ]);
  const history = suppliedHistory || safeJson(session?.history_json || "[]", []);
  if (!history.length) throw new Error("對話不存在，沒有內容可以更新");
  const turns = history.slice(-40).map(m => `${m.role === "user" ? "使用者" : "AI"}：${String(m.content || "").slice(0,1000)}`).join("\n\n");
  const response = await fetch("https://api.openai.com/v1/responses", { method:"POST", headers:{ authorization:`Bearer ${env.OPENAI_API_KEY}`, "content-type":"application/json" }, body:JSON.stringify({ model:env.OPENAI_MODEL||MODEL, instructions:MEMORY_PROMPT, input:`既有長期記憶：\n${profile?.memory||"（無）"}\n\n最近對話：\n${turns}`, store:false, max_output_tokens:800 }) });
  if (!response.ok) throw new Error("記憶更新失敗"); const memory=responseText(await response.json()).trim().slice(0,2000);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO profiles(uid,memory,memory_updated_at) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET memory=excluded.memory,memory_updated_at=excluded.memory_updated_at").bind(uid,memory,nowIso()),
    env.DB.prepare("UPDATE sessions SET memory_pending_since=NULL WHERE uid=? AND session_id=?").bind(uid,sessionId),
  ]);
  return memory;
}

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
  if (OFFICE_MIMES.has(mime)) {
    const text = extractOfficeText(bytes, mime);
    return { type: "input_text", text: text ? `以下是文件 ${req.file_name || "附件"} 的內容：\n${text}` : "（無法取出文件文字內容）" };
  }
  let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = `data:${mime};base64,${btoa(binary)}`;
  if (mime.startsWith("image/")) return { type: "input_image", image_url: data };
  return { type: "input_file", filename: req.file_name || "attachment", file_data: data };
}

export async function streamChat(request, env, authUser) {
  if (!env.OPENAI_API_KEY) return new Response(sse({ type: "error", message: "OpenAI 尚未設定" }), { status: 503, headers: { "content-type": "text/event-stream" } });
  const req = await request.json().catch(() => null);
  if (!req) return json({ detail: "請求格式不正確" }, 400);
  if (!req.session_id || !String(req.message || "").trim()) return json({ detail: "訊息不可為空" }, 400);
  const who = await identity(request, env, authUser);
  let fullHistory = Array.isArray(req.guest_history) ? req.guest_history : [], pendingSince = null, profile = {};
  if (!who.guest) {
    const [row, profileRow] = await Promise.all([env.DB.prepare("SELECT history_json,memory_pending_since FROM sessions WHERE uid=? AND session_id=?").bind(who.uid, req.session_id).first(), env.DB.prepare("SELECT system_prompt,memory FROM profiles WHERE uid=?").bind(who.uid).first()]);
    fullHistory = safeJson(row?.history_json || "[]", []);
    pendingSince = row?.memory_pending_since || null; profile = profileRow || {};
  }
  const history = fullHistory.slice(-10);
  const prefix = who.guest ? `uploads/guests/${request.headers.get("x-guest-id")}/` : `uploads/${who.uid}/`;
  const parts = [{ type: "input_text", text: req.quote ? `引用內容：\n${req.quote}\n\n問題：${req.message}` : req.message }];
  const attachment = await attachmentContent(req, env, prefix); if (attachment) parts.push(attachment);
  const input = history.map(m => ({ role: m.role, content: String(m.content || "") }));
  input.push({ role: "user", content: parts });
  const useSearch = !!(req.search_enabled || req.ntpu_search_enabled);
  let instructions = `${SYSTEM}\n今天是 ${new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}。`;
  if (profile.memory) instructions += `\n以下是使用者的長期記憶；若與最新訊息衝突，以最新訊息為準：\n${profile.memory}`;
  if (profile.system_prompt) instructions += `\n${profile.system_prompt}`;
  if (req.ntpu_search_enabled) instructions += "\n搜尋校內資訊時，優先且只採用 ntpu.edu.tw 網域的官方資料，回答附來源連結。";
  if (!useSearch) instructions += "\n你目前沒有啟用即時搜尋；需要最新資訊時提醒使用者開啟搜尋。";
  const model = env.OPENAI_MODEL || MODEL;
  const routingConfig = await loadRoutingConfig(env);
  const judge = await classifyDifficulty(env, req.message, history, routingConfig, model, !!authUser?.admin);
  const route = judge.route;
  const searchTool = req.ntpu_search_enabled && !req.search_enabled
    ? { type: "web_search", filters: { allowed_domains: ["ntpu.edu.tw"] } }
    : { type: "web_search" };
  const answerStartedAt = Date.now();
  const upstream = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify({ model, instructions, input, stream: true, store: false, safety_identifier: who.statsUid, ...(useSearch ? { tools: [searchTool] } : {}) }) });
  if (!upstream.ok || !upstream.body) return new Response(sse({ type: "error", message: "模型服務暫時無法回應" }), { status: 502, headers: { "content-type": "text/event-stream" } });
  const ts = new TransformStream(); const writer = ts.writable.getWriter(); const enc = new TextEncoder();
  const task = (async () => {
    let answer = "", buffer = "", inputTokens = 0, outputTokens = 0;
    await writer.write(enc.encode(sse({ type: "judge", route, model, judge: { score: judge.score, route, model, reason: judge.reason }, judge_model: judge.judge_model, judge_elapsed_ms: judge.judge_elapsed_ms })));
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
      const userMessage = { role: "user", content: req.message, ...(req.file_name ? { _file_name: req.file_name } : {}) };
      const next = [...fullHistory, userMessage, { role: "assistant", content: answer, _route: route, _model: model, _judge_model: judge.judge_model, _score: judge.score, _reason: judge.reason }];
      const title = String(next.find(x => x.role === "user")?.content || "對話").slice(0, 40);
      await env.DB.prepare("INSERT INTO sessions(uid,session_id,title,history_json,question_count,memory_pending_since,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(uid,session_id) DO UPDATE SET title=excluded.title,history_json=excluded.history_json,question_count=sessions.question_count+1,memory_pending_since=COALESCE(sessions.memory_pending_since,excluded.memory_pending_since),updated_at=excluded.updated_at")
        .bind(who.uid, req.session_id, title, JSON.stringify(next), pendingSince || now, now, now).run();
      if (pendingSince && Date.now() - Date.parse(pendingSince) >= 3*3600*1000) {
        try { await compressMemory(env, who.uid, req.session_id, next); } catch (e) { console.error("memory compression failed", e); }
      }
    }
    const totalInput = judge.usage.input_tokens + inputTokens, totalOutput = judge.usage.output_tokens + outputTokens;
    await env.DB.prepare("INSERT INTO usage_logs(stats_uid,email,session_id,access_type,model,route,score,input_tokens,output_tokens,guest_id_encrypted,created_at,judge_model,judge_input_tokens,judge_output_tokens,answer_input_tokens,answer_output_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .bind(who.statsUid, who.email, req.session_id, who.guest ? "guest" : "authenticated", model, route, judge.score, totalInput, totalOutput, who.encrypted, now, judge.judge_model, judge.usage.input_tokens, judge.usage.output_tokens, inputTokens, outputTokens).run();
    await writer.write(enc.encode(sse({ type: "done", answer_elapsed_ms: Date.now() - answerStartedAt }) + "data: [DONE]\n\n")); await writer.close();
  })().catch(async () => { try { await writer.write(enc.encode(sse({ type: "error", message: "系統暫時無法回應，請稍後再試" }))); await writer.close(); } catch {} });
  return new Response(ts.readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
