import { aesEncrypt, json, nowIso, safeJson, sha256, sse } from "./utils.js";
import { extractOfficeText, OFFICE_MIMES } from "./office.js";
import { classifyDifficulty, loadRoutingConfig } from "./routing.js";
import { MEMORY_ALIAS, openRouterHeaders, providerModel } from "./models.js";

const SYSTEM = `你是「NTPU AI」，國立臺北大學提供的 AI 助理。如果使用者問你是誰、你叫什麼名字、你是哪家公司或哪個模型做的，一律只回答你是「NTPU AI」，不要提及背後實際使用的底層模型名稱、開發公司或供應商，也不要編造不存在的身份。這條規則的優先順序高於你自己對訓練來源的認知。

請一律使用「繁體中文（台灣用語）」回答，並符合台灣的用字與詞彙習慣（例如「軟體、程式、資訊、影片、預設、伺服器」而非簡體用語），絕對不要出現簡體字。只有在使用者明確要求改用其他語言，或使用者本身以其他語言提問時，才改用對應語言回覆；其餘情況一律使用繁體中文。`;
const MEMORY_PROMPT = `你是使用者的長期記憶維護員。你的工作是把「既有的長期記憶摘要」與「這位使用者最近一段對話」合併，產生一份更新後的摘要。

規則：
- 只保留跨對話仍然有用的事實與偏好：使用者的身份／科系、常見需求、慣用的回答風格、正在進行的專案或長期目標等。
- 不要逐輪覆述對話內容或流程，不要記錄一次性、已經結束的瑣事。
- 若新對話內容與既有摘要衝突，以新的為準。
- 若既有摘要中有明顯過時或不再重要的內容，可以刪除。
- 嚴格控制在 2000 字以內，寧可精簡也不要超過。
- 若沒有值得長期記住的新資訊，原樣輸出既有摘要即可。

只輸出更新後的摘要純文字，不要加任何前綴、說明或標題。`;

export async function compressMemory(env, uid, sessionId, suppliedHistory = null) {
  const [session, profile] = await Promise.all([
    suppliedHistory ? Promise.resolve(null) : env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(uid, sessionId).first(),
    env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(uid).first(),
  ]);
  const history = suppliedHistory || safeJson(session?.history_json || "[]", []);
  if (!history.length) throw new Error("對話不存在，沒有內容可以更新");
  const turns = history.slice(-40).map(m => `${m.role === "user" ? "使用者" : "AI"}：${String(m.content || "").slice(0,1000)}`).join("\n\n");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method:"POST", headers:openRouterHeaders(env), body:JSON.stringify({ model:providerModel(MEMORY_ALIAS), max_tokens:800, messages:[{role:"system",content:MEMORY_PROMPT},{role:"user",content:`既有長期記憶：\n${profile?.memory||"（無）"}\n\n最近對話：\n${turns}`}] }) });
  if (!response.ok) throw new Error("記憶更新失敗"); const data=await response.json(); const memory=String(data.choices?.[0]?.message?.content||"").trim().slice(0,2000);
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
  if (mime.startsWith("text/") || /json|xml|javascript/.test(mime)) return { type: "text", text: `附件 ${req.file_name || "檔案"}：\n${new TextDecoder().decode(bytes).slice(0, 50000)}` };
  if (OFFICE_MIMES.has(mime)) {
    const text = extractOfficeText(bytes, mime);
    return { type: "text", text: text ? `以下是文件 ${req.file_name || "附件"} 的內容：\n${text}` : "（無法取出文件文字內容）" };
  }
  let binary = ""; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  const data = `data:${mime};base64,${btoa(binary)}`;
  if (mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("audio/") || mime.startsWith("video/")) return { type: "image_url", image_url: { url:data } };
  return { type: "text", text:`（系統無法解析 ${req.file_name || mime}，請改用 DOCX、PPTX、XLSX、PDF、圖片、音訊或影片）` };
}

export async function streamChat(request, env, authUser) {
  if (!env.OPENROUTER_API_KEY) return new Response(sse({ type: "error", message: "OpenRouter 尚未設定" }), { status: 503, headers: { "content-type": "text/event-stream" } });
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
  const parts = [{ type: "text", text: req.quote ? `使用者引用了對話中的這段內容提問：\n\"\"\"\n${req.quote}\n\"\"\"\n\n${req.message}` : req.message }];
  const attachment = await attachmentContent(req, env, prefix); if (attachment) parts.push(attachment);
  const useSearch = !!(req.search_enabled || req.ntpu_search_enabled);
  let instructions = `${SYSTEM}\n今天是 ${new Date().toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}。`;
  if (profile.memory) instructions += `\n以下是使用者的長期記憶；若與最新訊息衝突，以最新訊息為準：\n${profile.memory}`;
  if (profile.system_prompt) instructions += `\n${profile.system_prompt}`;
  if (useSearch && env.TAVILY_API_KEY) instructions += "\n你可以使用搜尋工具查詢即時或校內資訊；搜尋後只能根據工具結果回答並附來源。";
  else instructions += "\n你沒有即時上網或搜尋能力。若問題需要最新資訊，請建議使用者開啟搜尋；切勿假裝已搜尋或編造最新資料。";
  const routingConfig = await loadRoutingConfig(env);
  const judge = await classifyDifficulty(env, req.message, history, routingConfig, !!authUser?.admin);
  const route = judge.route, model = judge.model;
  const messages = [{ role:"system", content:instructions }, ...history.map(m => ({role:m.role,content:String(m.content||"")})), { role:"user", content:parts.length > 1 ? parts : parts[0].text }];
  const answerStartedAt = Date.now();
  const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", { method:"POST", headers:openRouterHeaders(env), body:JSON.stringify({ model:providerModel(model), messages, max_tokens:64000, stream:true, stream_options:{include_usage:true} }) });
  if (!upstream.ok || !upstream.body) return new Response(sse({ type: "error", message: "模型服務暫時無法回應" }), { status: 502, headers: { "content-type": "text/event-stream" } });
  const ts = new TransformStream(); const writer = ts.writable.getWriter(); const enc = new TextEncoder();
  const task = (async () => {
    let answer = "", reasoningFallback = "", buffer = "", inputTokens = 0, outputTokens = 0;
    await writer.write(enc.encode(sse({ type: "judge", route, model, judge: { score: judge.score, route, model, reason: judge.reason }, judge_model: judge.judge_model, judge_elapsed_ms: judge.judge_elapsed_ms })));
    const reader = upstream.body.getReader(); const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read(); if (done) break; buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue; const raw = line.slice(6); if (raw === "[DONE]") continue;
        const ev = safeJson(raw); if (!ev) continue;
        if (ev.usage) { inputTokens=ev.usage.prompt_tokens||0; outputTokens=ev.usage.completion_tokens||0; }
        const delta=ev.choices?.[0]?.delta || {}, content=delta.content || "";
        if (content) { answer+=content; await writer.write(enc.encode(sse({type:"token",content}))); }
        else reasoningFallback += delta.reasoning_content || "";
      }
    }
    if (!answer && reasoningFallback) { answer=reasoningFallback; await writer.write(enc.encode(sse({type:"token",content:answer}))); }
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
