import { __name, safeJson, nowIso, json, sse } from "./utils.js";
import { openRouterHeaders, providerModel, MEMORY_ALIAS, MODEL_CANDIDATES } from "./models.js";
import { loadRoutingConfig, classifyDifficulty } from "./routing.js";
import { OFFICE_MIMES, extractOfficeText } from "./office.js";

var SYSTEM = `\u4F60\u662F\u300CNTPU AI\u300D\uFF0C\u570B\u7ACB\u81FA\u5317\u5927\u5B78\u63D0\u4F9B\u7684 AI \u52A9\u7406\u3002\u5982\u679C\u4F7F\u7528\u8005\u554F\u4F60\u662F\u8AB0\u3001\u4F60\u53EB\u4EC0\u9EBC\u540D\u5B57\u3001\u4F60\u662F\u54EA\u5BB6\u516C\u53F8\u6216\u54EA\u500B\u6A21\u578B\u505A\u7684\uFF0C\u4E00\u5F8B\u53EA\u56DE\u7B54\u4F60\u662F\u300CNTPU AI\u300D\uFF0C\u4E0D\u8981\u63D0\u53CA\u80CC\u5F8C\u5BE6\u969B\u4F7F\u7528\u7684\u5E95\u5C64\u6A21\u578B\u540D\u7A31\u3001\u958B\u767C\u516C\u53F8\u6216\u4F9B\u61C9\u5546\uFF0C\u4E5F\u4E0D\u8981\u7DE8\u9020\u4E0D\u5B58\u5728\u7684\u8EAB\u4EFD\u3002\u9019\u689D\u898F\u5247\u7684\u512A\u5148\u9806\u5E8F\u9AD8\u65BC\u4F60\u81EA\u5DF1\u5C0D\u8A13\u7DF4\u4F86\u6E90\u7684\u8A8D\u77E5\u3002

\u8ACB\u4E00\u5F8B\u4F7F\u7528\u300C\u7E41\u9AD4\u4E2D\u6587\uFF08\u53F0\u7063\u7528\u8A9E\uFF09\u300D\u56DE\u7B54\uFF0C\u4E26\u7B26\u5408\u53F0\u7063\u7684\u7528\u5B57\u8207\u8A5E\u5F59\u7FD2\u6163\uFF08\u4F8B\u5982\u300C\u8EDF\u9AD4\u3001\u7A0B\u5F0F\u3001\u8CC7\u8A0A\u3001\u5F71\u7247\u3001\u9810\u8A2D\u3001\u4F3A\u670D\u5668\u300D\u800C\u975E\u7C21\u9AD4\u7528\u8A9E\uFF09\uFF0C\u7D55\u5C0D\u4E0D\u8981\u51FA\u73FE\u7C21\u9AD4\u5B57\u3002\u53EA\u6709\u5728\u4F7F\u7528\u8005\u660E\u78BA\u8981\u6C42\u6539\u7528\u5176\u4ED6\u8A9E\u8A00\uFF0C\u6216\u4F7F\u7528\u8005\u672C\u8EAB\u4EE5\u5176\u4ED6\u8A9E\u8A00\u63D0\u554F\u6642\uFF0C\u624D\u6539\u7528\u5C0D\u61C9\u8A9E\u8A00\u56DE\u8986\uFF1B\u5176\u9918\u60C5\u6CC1\u4E00\u5F8B\u4F7F\u7528\u7E41\u9AD4\u4E2D\u6587\u3002`;
var MEMORY_PROMPT = `\u4F60\u662F\u4F7F\u7528\u8005\u7684\u9577\u671F\u8A18\u61B6\u7DAD\u8B77\u54E1\u3002\u4F60\u7684\u5DE5\u4F5C\u662F\u628A\u300C\u65E2\u6709\u7684\u9577\u671F\u8A18\u61B6\u6458\u8981\u300D\u8207\u300C\u9019\u4F4D\u4F7F\u7528\u8005\u6700\u8FD1\u4E00\u6BB5\u5C0D\u8A71\u300D\u5408\u4F75\uFF0C\u7522\u751F\u4E00\u4EFD\u66F4\u65B0\u5F8C\u7684\u6458\u8981\u3002

\u898F\u5247\uFF1A
- \u53EA\u4FDD\u7559\u8DE8\u5C0D\u8A71\u4ECD\u7136\u6709\u7528\u7684\u4E8B\u5BE6\u8207\u504F\u597D\uFF1A\u4F7F\u7528\u8005\u7684\u8EAB\u4EFD\uFF0F\u79D1\u7CFB\u3001\u5E38\u898B\u9700\u6C42\u3001\u6163\u7528\u7684\u56DE\u7B54\u98A8\u683C\u3001\u6B63\u5728\u9032\u884C\u7684\u5C08\u6848\u6216\u9577\u671F\u76EE\u6A19\u7B49\u3002
- \u4E0D\u8981\u9010\u8F2A\u8986\u8FF0\u5C0D\u8A71\u5167\u5BB9\u6216\u6D41\u7A0B\uFF0C\u4E0D\u8981\u8A18\u9304\u4E00\u6B21\u6027\u3001\u5DF2\u7D93\u7D50\u675F\u7684\u7463\u4E8B\u3002
- \u82E5\u65B0\u5C0D\u8A71\u5167\u5BB9\u8207\u65E2\u6709\u6458\u8981\u885D\u7A81\uFF0C\u4EE5\u65B0\u7684\u70BA\u6E96\u3002
- \u82E5\u65E2\u6709\u6458\u8981\u4E2D\u6709\u660E\u986F\u904E\u6642\u6216\u4E0D\u518D\u91CD\u8981\u7684\u5167\u5BB9\uFF0C\u53EF\u4EE5\u522A\u9664\u3002
- \u56B4\u683C\u63A7\u5236\u5728 2000 \u5B57\u4EE5\u5167\uFF0C\u5BE7\u53EF\u7CBE\u7C21\u4E5F\u4E0D\u8981\u8D85\u904E\u3002
- \u82E5\u6C92\u6709\u503C\u5F97\u9577\u671F\u8A18\u4F4F\u7684\u65B0\u8CC7\u8A0A\uFF0C\u539F\u6A23\u8F38\u51FA\u65E2\u6709\u6458\u8981\u5373\u53EF\u3002

\u53EA\u8F38\u51FA\u66F4\u65B0\u5F8C\u7684\u6458\u8981\u7D14\u6587\u5B57\uFF0C\u4E0D\u8981\u52A0\u4EFB\u4F55\u524D\u7DB4\u3001\u8AAA\u660E\u6216\u6A19\u984C\u3002`;
export async function compressMemory(env, uid, sessionId, suppliedHistory = null) {
  const [session, profile] = await Promise.all([
    suppliedHistory ? Promise.resolve(null) : env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(uid, sessionId).first(),
    env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(uid).first()
  ]);
  const history = suppliedHistory || safeJson(session?.history_json || "[]", []);
  if (!history.length) throw new Error("\u5C0D\u8A71\u4E0D\u5B58\u5728\uFF0C\u6C92\u6709\u5167\u5BB9\u53EF\u4EE5\u66F4\u65B0");
  const turns = history.slice(-40).map((m2) => `${m2.role === "user" ? "\u4F7F\u7528\u8005" : "AI"}\uFF1A${String(m2.content || "").slice(0, 1e3)}`).join("\n\n");
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: openRouterHeaders(env), body: JSON.stringify({ model: providerModel(MEMORY_ALIAS), max_tokens: 800, messages: [{ role: "system", content: MEMORY_PROMPT }, { role: "user", content: `\u65E2\u6709\u9577\u671F\u8A18\u61B6\uFF1A
${profile?.memory || "\uFF08\u7121\uFF09"}

\u6700\u8FD1\u5C0D\u8A71\uFF1A
${turns}` }] }) });
  if (!response.ok) throw new Error("\u8A18\u61B6\u66F4\u65B0\u5931\u6557");
  const data = await response.json();
  const memory = String(data.choices?.[0]?.message?.content || "").trim().slice(0, 2e3);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO profiles(uid,memory,memory_updated_at) VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET memory=excluded.memory,memory_updated_at=excluded.memory_updated_at").bind(uid, memory, nowIso()),
    env.DB.prepare("UPDATE sessions SET memory_pending_since=NULL WHERE uid=? AND session_id=?").bind(uid, sessionId)
  ]);
  return memory;
}
__name(compressMemory, "compressMemory");
// OpenRouter 會依 max_tokens 先預扣費用；64k 會讓餘額不多時連短問題都被拒絕（402），一般回答遠用不到這麼多。
var ANSWER_MAX_TOKENS = 16e3;
async function identity(request, env, authUser) {
  if (authUser) return { uid: authUser.uid, statsUid: authUser.uid, email: authUser.email, guest: false, encrypted: "" };
  const guestId = request.headers.get("x-guest-id") || "";
  if (!/^[a-f0-9]{32}$/.test(guestId)) throw new Response(JSON.stringify({ detail: "Missing auth token or guest ID" }), { status: 401 });
  return { uid: "anonymous", statsUid: `guest:${guestId}`, email: "", guest: true, encrypted: "" };
}
__name(identity, "identity");
async function attachmentContent(req, env, ownerPrefix) {
  if (!req.file_gcs_path || !env.UPLOADS) return null;
  if (!req.file_gcs_path.startsWith(ownerPrefix)) throw new Response(JSON.stringify({ detail: "\u7121\u6CD5\u5B58\u53D6\u6B64\u9644\u4EF6" }), { status: 403 });
  const object = await env.UPLOADS.get(req.file_gcs_path);
  if (!object) return null;
  const mime = req.file_mime_type || object.httpMetadata?.contentType || "application/octet-stream";
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (mime.startsWith("text/") || /json|xml|javascript/.test(mime)) return { type: "text", text: `\u9644\u4EF6 ${req.file_name || "\u6A94\u6848"}\uFF1A
${new TextDecoder().decode(bytes).slice(0, 5e4)}` };
  if (OFFICE_MIMES.has(mime)) {
    const text = extractOfficeText(bytes, mime);
    return { type: "text", text: text ? `\u4EE5\u4E0B\u662F\u6587\u4EF6 ${req.file_name || "\u9644\u4EF6"} \u7684\u5167\u5BB9\uFF1A
${text}` : "\uFF08\u7121\u6CD5\u53D6\u51FA\u6587\u4EF6\u6587\u5B57\u5167\u5BB9\uFF09" };
  }
  let binary = "";
  for (let i3 = 0; i3 < bytes.length; i3 += 32768) binary += String.fromCharCode(...bytes.subarray(i3, i3 + 32768));
  const data = `data:${mime};base64,${btoa(binary)}`;
  if (mime.startsWith("image/") || mime === "application/pdf" || mime.startsWith("audio/") || mime.startsWith("video/")) return { type: "image_url", image_url: { url: data } };
  return { type: "text", text: `\uFF08\u7CFB\u7D71\u7121\u6CD5\u89E3\u6790 ${req.file_name || mime}\uFF0C\u8ACB\u6539\u7528 DOCX\u3001PPTX\u3001XLSX\u3001PDF\u3001\u5716\u7247\u3001\u97F3\u8A0A\u6216\u5F71\u7247\uFF09` };
}
__name(attachmentContent, "attachmentContent");
export async function streamChat(request, env, authUser) {
  if (!env.OPENROUTER_API_KEY) return new Response(sse({ type: "error", message: "OpenRouter \u5C1A\u672A\u8A2D\u5B9A" }), { status: 503, headers: { "content-type": "text/event-stream" } });
  const req = await request.json().catch(() => null);
  if (!req) return json({ detail: "\u8ACB\u6C42\u683C\u5F0F\u4E0D\u6B63\u78BA" }, 400);
  if (!req.session_id || !String(req.message || "").trim()) return json({ detail: "\u8A0A\u606F\u4E0D\u53EF\u70BA\u7A7A" }, 400);
  const who = await identity(request, env, authUser);
  let fullHistory = Array.isArray(req.guest_history) ? req.guest_history : [], pendingSince = null, profile = {};
  if (!who.guest) {
    const [row, profileRow] = await Promise.all([env.DB.prepare("SELECT history_json,memory_pending_since FROM sessions WHERE uid=? AND session_id=?").bind(who.uid, req.session_id).first(), env.DB.prepare("SELECT system_prompt,memory FROM profiles WHERE uid=?").bind(who.uid).first()]);
    fullHistory = safeJson(row?.history_json || "[]", []);
    pendingSince = row?.memory_pending_since || null;
    profile = profileRow || {};
  }
  const history = fullHistory.slice(-10);
  const prefix = who.guest ? `uploads/guests/${request.headers.get("x-guest-id")}/` : `uploads/${who.uid}/`;
  const parts = [{ type: "text", text: req.quote ? `\u4F7F\u7528\u8005\u5F15\u7528\u4E86\u5C0D\u8A71\u4E2D\u7684\u9019\u6BB5\u5167\u5BB9\u63D0\u554F\uFF1A
"""
${req.quote}
"""

${req.message}` : req.message }];
  const attachment = await attachmentContent(req, env, prefix);
  if (attachment) parts.push(attachment);
  const useSearch = !!(req.search_enabled || req.ntpu_search_enabled);
  let instructions = `${SYSTEM}
\u4ECA\u5929\u662F ${(/* @__PURE__ */ new Date()).toLocaleDateString("zh-TW", { timeZone: "Asia/Taipei" })}\u3002`;
  if (profile.memory) instructions += `
\u4EE5\u4E0B\u662F\u4F7F\u7528\u8005\u7684\u9577\u671F\u8A18\u61B6\uFF1B\u82E5\u8207\u6700\u65B0\u8A0A\u606F\u885D\u7A81\uFF0C\u4EE5\u6700\u65B0\u8A0A\u606F\u70BA\u6E96\uFF1A
${profile.memory}`;
  if (profile.system_prompt) instructions += `
${profile.system_prompt}`;
  if (useSearch && env.TAVILY_API_KEY) instructions += "\n\u4F60\u53EF\u4EE5\u4F7F\u7528\u641C\u5C0B\u5DE5\u5177\u67E5\u8A62\u5373\u6642\u6216\u6821\u5167\u8CC7\u8A0A\uFF1B\u641C\u5C0B\u5F8C\u53EA\u80FD\u6839\u64DA\u5DE5\u5177\u7D50\u679C\u56DE\u7B54\u4E26\u9644\u4F86\u6E90\u3002";
  else instructions += "\n\u4F60\u6C92\u6709\u5373\u6642\u4E0A\u7DB2\u6216\u641C\u5C0B\u80FD\u529B\u3002\u82E5\u554F\u984C\u9700\u8981\u6700\u65B0\u8CC7\u8A0A\uFF0C\u8ACB\u5EFA\u8B70\u4F7F\u7528\u8005\u958B\u555F\u641C\u5C0B\uFF1B\u5207\u52FF\u5047\u88DD\u5DF2\u641C\u5C0B\u6216\u7DE8\u9020\u6700\u65B0\u8CC7\u6599\u3002";
  const routingConfig = await loadRoutingConfig(env);
  const judge = await classifyDifficulty(env, req.message, history, routingConfig, !!authUser?.admin);
  const route = judge.route;
  let model = judge.model;
  const messages = [{ role: "system", content: instructions }, ...history.map((m2) => ({ role: m2.role, content: String(m2.content || "") })), { role: "user", content: parts.length > 1 ? parts : parts[0].text }];
  const answerStartedAt = Date.now();
  // 某個模型失敗（例如 403「此地區無法使用」）時，改用同級距的下一個模型；402 是餘額不足，換模型也沒用。
  const fallbacks = [model, ...(MODEL_CANDIDATES[route] || []).filter((m2) => m2 !== model)];
  let upstream;
  for (const candidate of fallbacks) {
    upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", { method: "POST", headers: openRouterHeaders(env), body: JSON.stringify({ model: providerModel(candidate), messages, max_tokens: ANSWER_MAX_TOKENS, stream: true, stream_options: { include_usage: true } }) });
    if (upstream.ok && upstream.body) { model = candidate; break; }
    const detail = await upstream.text().catch(() => "");
    console.error("OpenRouter answer request failed", upstream.status, providerModel(candidate), detail.slice(0, 500));
    if (upstream.status === 402) break;
  }
  if (!upstream.ok || !upstream.body) {
    // 402 是 OpenRouter 餘額不足；其他狀態多半是模型暫時無法使用。
    const message = upstream.status === 402 ? "AI \u670D\u52D9\u984D\u5EA6\u4E0D\u8DB3\uFF0C\u8ACB\u901A\u77E5\u7BA1\u7406\u54E1" : "\u6A21\u578B\u670D\u52D9\u66AB\u6642\u7121\u6CD5\u56DE\u61C9";
    return new Response(sse({ type: "error", message }), { status: 502, headers: { "content-type": "text/event-stream" } });
  }
  const ts = new TransformStream();
  const writer = ts.writable.getWriter();
  const enc2 = new TextEncoder();
  const task = (async () => {
    let answer = "", reasoningFallback = "", buffer = "", inputTokens = 0, outputTokens = 0;
    await writer.write(enc2.encode(sse({ type: "judge", route, model, judge: { score: judge.score, route, model, reason: judge.reason }, judge_model: judge.judge_model, judge_elapsed_ms: judge.judge_elapsed_ms })));
    const reader = upstream.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const raw = line.slice(6);
        if (raw === "[DONE]") continue;
        const ev = safeJson(raw);
        if (!ev) continue;
        if (ev.usage) {
          inputTokens = ev.usage.prompt_tokens || 0;
          outputTokens = ev.usage.completion_tokens || 0;
        }
        const delta = ev.choices?.[0]?.delta || {}, content = delta.content || "";
        if (content) {
          answer += content;
          await writer.write(enc2.encode(sse({ type: "token", content })));
        } else reasoningFallback += delta.reasoning_content || "";
      }
    }
    if (!answer && reasoningFallback) {
      answer = reasoningFallback;
      await writer.write(enc2.encode(sse({ type: "token", content: answer })));
    }
    const now = nowIso();
    if (!who.guest) {
      const userMessage = { role: "user", content: req.message, ...req.file_name ? { _file_name: req.file_name } : {} };
      const next = [...fullHistory, userMessage, { role: "assistant", content: answer, _route: route, _model: model, _judge_model: judge.judge_model, _score: judge.score, _reason: judge.reason }];
      const title = String(next.find((x3) => x3.role === "user")?.content || "\u5C0D\u8A71").slice(0, 40);
      await env.DB.prepare("INSERT INTO sessions(uid,session_id,title,history_json,question_count,memory_pending_since,created_at,updated_at) VALUES(?,?,?,?,1,?,?,?) ON CONFLICT(uid,session_id) DO UPDATE SET title=excluded.title,history_json=excluded.history_json,question_count=sessions.question_count+1,memory_pending_since=COALESCE(sessions.memory_pending_since,excluded.memory_pending_since),updated_at=excluded.updated_at").bind(who.uid, req.session_id, title, JSON.stringify(next), pendingSince || now, now, now).run();
      if (pendingSince && Date.now() - Date.parse(pendingSince) >= 3 * 3600 * 1e3) {
        try {
          await compressMemory(env, who.uid, req.session_id, next);
        } catch (e2) {
          console.error("memory compression failed", e2);
        }
      }
    }
    const totalInput = judge.usage.input_tokens + inputTokens, totalOutput = judge.usage.output_tokens + outputTokens;
    await env.DB.prepare("INSERT INTO usage_logs(stats_uid,email,session_id,access_type,model,route,score,input_tokens,output_tokens,guest_id_encrypted,created_at,judge_model,judge_input_tokens,judge_output_tokens,answer_input_tokens,answer_output_tokens) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(who.statsUid, who.email, req.session_id, who.guest ? "guest" : "authenticated", model, route, judge.score, totalInput, totalOutput, who.encrypted, now, judge.judge_model, judge.usage.input_tokens, judge.usage.output_tokens, inputTokens, outputTokens).run();
    await writer.write(enc2.encode(sse({ type: "done", answer_elapsed_ms: Date.now() - answerStartedAt }) + "data: [DONE]\n\n"));
    await writer.close();
  })().catch(async () => {
    try {
      await writer.write(enc2.encode(sse({ type: "error", message: "\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u56DE\u61C9\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66" })));
      await writer.close();
    } catch {
    }
  });
  return new Response(ts.readable, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache" } });
}
__name(streamChat, "streamChat");
