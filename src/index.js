import { Converter } from "opencc-js";
import {
  __name,
  json,
  error,
  safeJson,
  randomHex,
  nowIso,
  requireSameOrigin,
  securityHeaders,
  aesDecrypt
} from "./utils.js";
import {
  authenticate,
  requireAdmin,
  logout,
  requireTurnstile,
  verifyTurnstile
} from "./auth.js";
import { loginWithSaml, handleAcs, handleSpMetadata } from "./saml.js";
import { compressMemory, streamChat } from "./chat.js";
import { OFFICE_MIMES, extractOfficeText } from "./office.js";
import {
  MODEL_CANDIDATES,
  MODEL_NOTES,
  MODEL_TO_ROUTE,
  JUDGE_ALIAS,
  providerModel,
  OPENROUTER_PRICING
} from "./models.js";

var owner = /* @__PURE__ */ __name(async (req, env) => authenticate(req, env), "owner");
var pathMatch = /* @__PURE__ */ __name((path, re) => path.match(re), "pathMatch");
var toTaiwanTraditional = Converter({ from: "cn", to: "twp" });
var hasUnsupportedTranscriptionScript = /* @__PURE__ */ __name((value) => [...String(value || "")].some(
  (char) => /\p{L}/u.test(char) && !/[\p{Script=Han}\p{Script=Latin}]/u.test(char)
), "hasUnsupportedTranscriptionScript");
var normalizeTranscription = /* @__PURE__ */ __name((value) => toTaiwanTraditional(String(value || "").normalize("NFC").trim()), "normalizeTranscription");
var CHAT_PER_MINUTE_LIMIT = 10;
var GUEST_QUESTION_LIMIT = 10;
var GUEST_IP_DAILY_LIMIT = 30;
// window_start 固定為 0，等於不分時段、永久累計。
var FOREVER_SECONDS = 100 * 365 * 86400;
async function enforceRateLimit(env, key, limit, windowSeconds = 60) {
  const windowStart = Math.floor(Date.now() / 1e3 / windowSeconds) * windowSeconds;
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits(limiter_key,window_start,request_count) VALUES(?,?,1)
    ON CONFLICT(limiter_key,window_start) DO UPDATE SET request_count=request_count+1
    RETURNING request_count
  `).bind(key, windowStart).first();
  if ((row?.request_count || 1) > limit) return error("\u8ACB\u6C42\u904E\u65BC\u983B\u7E41\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66", 429);
  return null;
}
__name(enforceRateLimit, "enforceRateLimit");
function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || "unknown";
}
__name(clientIp, "clientIp");
async function conversations(req, env, url) {
  const user = await owner(req, env);
  const path = url.pathname;
  if (path === "/conversations" && req.method === "GET") {
    const rows = await env.DB.prepare("SELECT session_id,title,updated_at FROM sessions WHERE uid=? ORDER BY updated_at DESC LIMIT 100").bind(user.uid).all();
    return json(rows.results || [], 200, { "cache-control": "no-store" });
  }
  const m2 = pathMatch(path, /^\/conversations\/([^/]+)$/);
  if (m2 && req.method === "GET") {
    const row = await env.DB.prepare("SELECT title,history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, decodeURIComponent(m2[1])).first();
    if (!row) return error("\u5C0D\u8A71\u4E0D\u5B58\u5728", 404);
    return json({ session_id: decodeURIComponent(m2[1]), title: row.title, history: safeJson(row.history_json, []) });
  }
  const status = pathMatch(path, /^\/conversations\/([^/]+)\/memory-status$/);
  if (status && req.method === "GET") {
    const sid = decodeURIComponent(status[1]);
    const row = await env.DB.prepare("SELECT memory_pending_since FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    return json({ pending_since: row?.memory_pending_since || null, interval_hours: 3 });
  }
  const compress = pathMatch(path, /^\/conversations\/([^/]+)\/memory-compress-now$/);
  if (compress && req.method === "POST") {
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    const sid = decodeURIComponent(compress[1]);
    const row = await env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    const history = safeJson(row?.history_json || "[]", []);
    if (!history.length) return error("\u5C0D\u8A71\u4E0D\u5B58\u5728\uFF0C\u6C92\u6709\u5167\u5BB9\u53EF\u4EE5\u66F4\u65B0", 404);
    await compressMemory(env, user.uid, sid, history);
    return json({ ok: true });
  }
  const share = pathMatch(path, /^\/conversations\/([^/]+)\/share$/);
  if (share && req.method === "POST") {
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    const sid = decodeURIComponent(share[1]);
    const row = await env.DB.prepare("SELECT title,history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    if (!row) return error("\u5C0D\u8A71\u4E0D\u5B58\u5728", 404);
    const id = randomHex(12);
    await env.DB.prepare("INSERT INTO shares VALUES(?,?,?,?,?,?)").bind(id, user.uid, sid, row.title, row.history_json, nowIso()).run();
    return json({ share_id: id });
  }
  return error("Not found", 404);
}
__name(conversations, "conversations");
async function upload(req, env) {
  const user = await authenticate(req, env, false);
  const guest = req.headers.get("x-guest-id") || "";
  if (!user && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
  if (!user) {
    const turnstileError = await requireTurnstile(req, env);
    if (turnstileError) return turnstileError;
  }
  const limited = await enforceRateLimit(env, `upload:${user?.uid || `${clientIp(req)}:${guest}`}`, 10);
  if (limited) return limited;
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return error("\u7F3A\u5C11\u6A94\u6848", 400);
  if (file.size > 20 * 1024 * 1024) return error("\u6A94\u6848\u8D85\u904E 20MB \u4E0A\u9650", 413);
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || "").toLowerCase();
  const prefix = user ? `uploads/${user.uid}` : `uploads/guests/${guest}`;
  const key = `${prefix}/${Date.now()}_${randomHex(4)}${ext}`;
  await env.UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { filename: file.name } });
  return json({ gcs_path: key, filename: file.name, mime_type: file.type, size: file.size });
}
__name(upload, "upload");
async function preview(req, env, url) {
  const user = await authenticate(req, env, false);
  const guest = req.headers.get("x-guest-id") || "";
  if (!user && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
  const limited = await enforceRateLimit(env, `preview:${user?.uid || `${clientIp(req)}:${guest}`}`, 30);
  if (limited) return limited;
  const key = url.searchParams.get("path") || "";
  const prefix = user ? `uploads/${user.uid}/` : `uploads/guests/${guest}/`;
  if (!key.startsWith(prefix)) return error("\u7121\u6CD5\u5B58\u53D6\u6B64\u9644\u4EF6", 403);
  const object = await env.UPLOADS.get(key);
  if (!object) return error("\u6A94\u6848\u4E0D\u5B58\u5728", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  const type = headers.get("content-type") || "application/octet-stream";
  if (OFFICE_MIMES.has(type)) {
    const text = extractOfficeText(new Uint8Array(await object.arrayBuffer()), type);
    return new Response(text || "\uFF08\u7121\u6CD5\u53D6\u51FA\u6587\u5B57\u5167\u5BB9\uFF09", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (/html|svg/.test(type) || type.startsWith("text/")) headers.set("content-type", "text/plain; charset=utf-8");
  if (!type.startsWith("image/") && !type.startsWith("audio/") && !type.startsWith("video/") && type !== "application/pdf" && !type.startsWith("text/")) headers.set("content-disposition", "attachment");
  return new Response(object.body, { headers });
}
__name(preview, "preview");
async function transcribe(req, env) {
  const user = await owner(req, env);
  const limited = await enforceRateLimit(env, `upload:${user.uid}`, 10);
  if (limited) return limited;
  if (!env.AI) return error("Cloudflare Workers AI \u5C1A\u672A\u555F\u7528", 503);
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return error("\u7F3A\u5C11\u97F3\u6A94", 400);
  if (file.size > 25 * 1024 * 1024) return error("\u97F3\u6A94\u904E\u5927\uFF08\u4E0A\u9650 25 MB\uFF09", 413);
  const chinese = String(form.get("lang") || "zh").startsWith("zh");
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 32768) binary += String.fromCharCode(...bytes.subarray(index, index + 32768));
  const audio = btoa(binary);
  let result;
  try {
    result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio,
      task: "transcribe",
      language: chinese ? "zh" : "en",
      vad_filter: true,
      beam_size: 8,
      condition_on_previous_text: false,
      no_speech_threshold: 0.5,
      compression_ratio_threshold: 2.2,
      log_prob_threshold: -0.8,
      hallucination_silence_threshold: 1
    });
  } catch (cause) {
    console.error("Cloudflare Workers AI transcription failed", cause);
    return error("Cloudflare \u8A9E\u97F3\u670D\u52D9\u66AB\u6642\u5931\u6557\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66", 502);
  }
  let text = String(result?.text || "").trim();
  if (!text) return error("\u6C92\u6709\u8FA8\u8B58\u5230\u8A9E\u97F3\uFF0C\u8ACB\u9760\u8FD1\u9EA5\u514B\u98A8\u518D\u8A66\u4E00\u6B21", 400);
  if (/逐字轉錄語音|不要回答或改寫|Transcribe the audio verbatim/i.test(text)) {
    console.error("Transcription prompt echo rejected");
    return error("\u9019\u6BB5\u9304\u97F3\u592A\u77ED\u6216\u4E0D\u6E05\u695A\uFF0C\u8ACB\u518D\u9304\u4E00\u6B21", 400);
  }
  if (hasUnsupportedTranscriptionScript(text)) {
    console.warn("Transcription contains a non-Chinese/non-English script");
    return error("\u8A9E\u97F3\u8F38\u5165\u50C5\u652F\u63F4\u7E41\u9AD4\u4E2D\u6587\u8207\u82F1\u6587\uFF0C\u8ACB\u9760\u8FD1\u9EA5\u514B\u98A8\u4E26\u8AAA\u6162\u4E00\u9EDE\u5F8C\u91CD\u8A66", 400);
  }
  return json({ text: normalizeTranscription(text) });
}
__name(transcribe, "transcribe");
var MESSAGE_FEEDBACK_REASONS = [
  "slow",
  // 產生回答等太久
  "wrong",
  // 內容錯誤或憑空捏造
  "outdated",
  // 資訊過時
  "off_topic",
  // 沒回答到問題
  "too_vague",
  // 太籠統、沒有可用內容
  "too_long",
  // 太冗長或一直重複
  "file",
  // 沒有正確讀取附件
  "language",
  // 語言或用字不符（例如出現簡體字）
  "other"
];
async function messageFeedback(req, env, url) {
  const user = await authenticate(req, env, false);
  const guest = req.headers.get("x-guest-id") || "";
  if (!user && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
  const statsUid = user?.uid || `guest:${guest}`;
  if (req.method === "GET") {
    const sessionId = url.searchParams.get("session_id") || "";
    if (!sessionId) return error("\u7F3A\u5C11 session_id", 400);
    const rows = await env.DB.prepare("SELECT answer_index,vote,reasons,comment FROM message_feedback WHERE stats_uid=? AND session_id=?").bind(statsUid, sessionId).all();
    return json((rows.results || []).map((x3) => ({ answer_index: x3.answer_index, vote: x3.vote, reasons: safeJson(x3.reasons, []), comment: x3.comment || "" })));
  }
  if (req.method !== "POST") return error("Not found", 404);
  const body = await req.json().catch(() => null);
  if (!body?.session_id) return error("\u7F3A\u5C11 session_id", 400);
  const answerIndex = Number(body.answer_index);
  if (!Number.isInteger(answerIndex) || answerIndex < 0) return error("answer_index \u4E0D\u6B63\u78BA", 400);
  if (body.vote === null) {
    await env.DB.prepare("DELETE FROM message_feedback WHERE stats_uid=? AND session_id=? AND answer_index=?").bind(statsUid, body.session_id, answerIndex).run();
    return json({ ok: true, vote: null });
  }
  if (!["up", "down"].includes(body.vote)) return error("vote \u53EA\u80FD\u662F up \u6216 down", 400);
  const reasons = body.vote === "down" && Array.isArray(body.reasons) ? [...new Set(body.reasons.filter((x3) => MESSAGE_FEEDBACK_REASONS.includes(x3)))] : [];
  const comment = body.vote === "down" ? String(body.comment || "").trim().slice(0, 1e3) : "";
  const elapsedMs = Math.max(0, Math.min(6e5, Math.round(Number(body.elapsed_ms) || 0)));
  await env.DB.prepare(`
    INSERT INTO message_feedback(stats_uid,session_id,answer_index,vote,reasons,comment,is_guest,email,model,route,elapsed_ms,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(stats_uid,session_id,answer_index) DO UPDATE SET
      vote=excluded.vote,reasons=excluded.reasons,comment=excluded.comment,
      model=excluded.model,route=excluded.route,elapsed_ms=excluded.elapsed_ms,created_at=excluded.created_at
  `).bind(statsUid, body.session_id, answerIndex, body.vote, JSON.stringify(reasons), comment, user ? 0 : 1, user?.email || "", String(body.model || "").slice(0, 60), String(body.route || "").slice(0, 20), elapsedMs, nowIso()).run();
  return json({ ok: true, vote: body.vote });
}
__name(messageFeedback, "messageFeedback");
async function adminStats(env, url) {
  const start = url.searchParams.get("start") || new Date(Date.now() - 30 * 864e5).toISOString();
  const end = url.searchParams.get("end") || nowIso();
  const [usageResult, feedbackResult, messageResult] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM usage_logs WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20000").bind(start, end),
    env.DB.prepare("SELECT * FROM feedback WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20000").bind(start, end),
    env.DB.prepare("SELECT * FROM message_feedback WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20000").bind(start, end)
  ]);
  const userMap = /* @__PURE__ */ new Map(), sessionMap = /* @__PURE__ */ new Map(), modelMap = /* @__PURE__ */ new Map(), legacyGuestUidMap = /* @__PURE__ */ new Map();
  for (const row of usageResult.results || []) {
    let statsUid = row.stats_uid;
    if (legacyGuestUidMap.has(row.stats_uid)) {
      statsUid = legacyGuestUidMap.get(row.stats_uid);
    } else if (row.access_type === "guest" && row.guest_id_encrypted && env.GUEST_ID_ENCRYPTION_KEY) {
      try {
        statsUid = `guest:${await aesDecrypt(row.guest_id_encrypted, env.GUEST_ID_ENCRYPTION_KEY, row.stats_uid)}`;
        legacyGuestUidMap.set(row.stats_uid, statsUid);
      } catch {
      }
    }
    if (!userMap.has(statsUid)) userMap.set(statsUid, { uid: statsUid, email: row.email || "", is_guest: row.access_type === "guest" || statsUid.startsWith("guest:"), total: 0, conversations: 0, small: 0, medium: 0, large: 0, tiny: 0, input_tokens: 0, output_tokens: 0 });
    const user = userMap.get(statsUid);
    user.total++;
    user.input_tokens += row.input_tokens || 0;
    user.output_tokens += row.output_tokens || 0;
    if (["small", "medium", "large", "tiny"].includes(row.route)) user[row.route]++;
    const sessionKey = `${statsUid}\0${row.session_id}`;
    sessionMap.set(sessionKey, (sessionMap.get(sessionKey) || 0) + 1);
    const addModel = /* @__PURE__ */ __name((name, input, output) => {
      if (!name) return;
      if (!modelMap.has(name)) modelMap.set(name, { model: name, requests: 0, input_tokens: 0, output_tokens: 0 });
      const item = modelMap.get(name);
      item.requests++;
      item.input_tokens += input || 0;
      item.output_tokens += output || 0;
    }, "addModel");
    if (row.judge_model) {
      addModel(row.judge_model, row.judge_input_tokens, row.judge_output_tokens);
      addModel(row.model, row.answer_input_tokens, row.answer_output_tokens);
    } else addModel(row.model, row.input_tokens, row.output_tokens);
  }
  let eligibleSurveySessions = 0;
  for (const [key, count] of sessionMap) {
    userMap.get(key.split("\0")[0]).conversations++;
    if (count >= 3) eligibleSurveySessions++;
  }
  const users = [...userMap.values()].sort((a2, b3) => b3.total - a2.total);
  const roundUsd = /* @__PURE__ */ __name((value) => Math.round(value * 1e8) / 1e8, "roundUsd");
  const by_model = [...modelMap.values()].map((item) => {
    const provider_model = providerModel(item.model);
    const pricing = OPENROUTER_PRICING.usd_per_million[provider_model];
    const input_cost_usd = pricing ? roundUsd(item.input_tokens * pricing.input / 1e6) : null;
    const output_cost_usd = pricing ? roundUsd(item.output_tokens * pricing.output / 1e6) : null;
    return {
      ...item,
      provider_model,
      input_price_usd_per_million: pricing?.input ?? null,
      output_price_usd_per_million: pricing?.output ?? null,
      input_cost_usd,
      output_cost_usd,
      estimated_cost_usd: pricing ? roundUsd(input_cost_usd + output_cost_usd) : null
    };
  }).sort((a2, b3) => b3.input_tokens + b3.output_tokens - (a2.input_tokens + a2.output_tokens));
  const token_usage = by_model.reduce((summary, item) => {
    summary.input_tokens += item.input_tokens;
    summary.output_tokens += item.output_tokens;
    if (item.estimated_cost_usd === null) summary.unpriced_models.push(item.provider_model);
    else summary.estimated_cost_usd += item.estimated_cost_usd;
    return summary;
  }, { input_tokens: 0, output_tokens: 0, estimated_cost_usd: 0, unpriced_models: [] });
  token_usage.estimated_cost_usd = roundUsd(token_usage.estimated_cost_usd);
  token_usage.pricing_as_of = OPENROUTER_PRICING.as_of;
  token_usage.pricing_source = OPENROUTER_PRICING.source;
  const distribution = { "1": 0, "2": 0, "3": 0, "4": 0, "5": 0 };
  let sum = 0, positive = 0;
  const feedback = (feedbackResult.results || []).filter((x3) => x3.rating >= 1 && x3.rating <= 5).map((x3) => {
    distribution[String(x3.rating)]++;
    sum += x3.rating;
    if (x3.rating >= 4) positive++;
    return { uid: legacyGuestUidMap.get(x3.stats_uid) || x3.stats_uid, email: x3.email || "", is_guest: !!x3.is_guest, session_id: x3.session_id, rating: x3.rating, question_count: x3.question_count || 0, timestamp: x3.created_at };
  });
  const responses = feedback.length;
  const reasonCounts = Object.fromEntries(MESSAGE_FEEDBACK_REASONS.map((x3) => [x3, 0]));
  const messageModelMap = /* @__PURE__ */ new Map();
  let up = 0, down = 0, withComment = 0, slowReports = 0, slowElapsedSum = 0, slowElapsedCount = 0;
  const messageComments = [];
  for (const row of messageResult?.results || []) {
    const uid = legacyGuestUidMap.get(row.stats_uid) || row.stats_uid;
    if (row.vote === "up") up++;
    else down++;
    if (row.model) {
      if (!messageModelMap.has(row.model)) messageModelMap.set(row.model, { model: row.model, up: 0, down: 0 });
      messageModelMap.get(row.model)[row.vote === "up" ? "up" : "down"]++;
    }
    const reasons = safeJson(row.reasons, []) || [];
    for (const reason of reasons) if (reason in reasonCounts) reasonCounts[reason]++;
    if (row.vote === "down") {
      if (row.comment) withComment++;
      if (reasons.includes("slow")) {
        slowReports++;
        if (row.elapsed_ms) {
          slowElapsedSum += row.elapsed_ms;
          slowElapsedCount++;
        }
      }
      messageComments.push({
        uid,
        email: row.email || "",
        is_guest: !!row.is_guest,
        session_id: row.session_id,
        answer_index: row.answer_index,
        model: row.model || "",
        route: row.route || "",
        reasons,
        comment: row.comment || "",
        elapsed_ms: row.elapsed_ms || 0,
        timestamp: row.created_at
      });
    }
  }
  const messageTotal = up + down;
  const message_feedback = {
    total: messageTotal,
    up,
    down,
    positive_percent: messageTotal ? Math.round(up * 1e3 / messageTotal) / 10 : 0,
    with_comment: withComment,
    slow_reports: slowReports,
    slow_avg_ms: slowElapsedCount ? Math.round(slowElapsedSum / slowElapsedCount) : 0,
    reasons: reasonCounts,
    by_model: [...messageModelMap.values()].sort((a2, b3) => b3.up + b3.down - (a2.up + a2.down)),
    comments: messageComments.slice(0, 200)
  };
  return { users, by_model, token_usage, message_feedback, satisfaction: { responses, average: responses ? Math.round(sum / responses * 100) / 100 : 0, csat_percent: responses ? Math.round(positive * 1e3 / responses) / 10 : 0, response_rate: eligibleSurveySessions ? Math.min(100, Math.round(responses * 1e3 / eligibleSurveySessions) / 10) : 0, distribution }, feedback };
}
__name(adminStats, "adminStats");
async function admin(req, env, url) {
  const user = await requireAdmin(req, env);
  const p2 = url.pathname;
  if (p2 === "/admin/setup" && req.method === "POST") {
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    return json({ ok: true });
  }
  if (p2 === "/admin/config") {
    if (req.method === "GET") {
      const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE key='routing'").first();
      return json({ threshold_tiny: null, threshold_medium: 4, threshold_large: 7, force_model: null, prefer_local: false, ...safeJson(row?.value_json || "{}", {}) });
    }
    const body = await req.json();
    const force = body.force_model;
    if (force && !["small", "medium", "large", "tiny"].includes(force) && !MODEL_TO_ROUTE[force]) return error(`\u6A21\u578B ${force} \u5C1A\u672A\u5728\u76EE\u524D\u74B0\u5883\u8A3B\u518A`, 400);
    await env.DB.prepare("INSERT INTO app_config VALUES('routing',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(JSON.stringify(body), nowIso()).run();
    return json({ ok: true });
  }
  if (p2 === "/admin/stats") return json(await adminStats(env, url));
  if (p2 === "/admin/users" && req.method === "GET") {
    const rows = await env.DB.prepare("SELECT uid,email,is_admin,created_at,last_login_at FROM users ORDER BY created_at DESC").all();
    return json(rows.results || []);
  }
  const toggle = pathMatch(p2, /^\/admin\/users\/([^/]+)\/toggle-admin$/);
  if (toggle && req.method === "POST") {
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    const body = await req.json().catch(() => null);
    if (typeof body?.is_admin !== "boolean") return error("is_admin \u5FC5\u9808\u662F\u5E03\u6797\u503C", 400);
    await env.DB.prepare("UPDATE users SET is_admin=? WHERE uid=?").bind(body.is_admin ? 1 : 0, decodeURIComponent(toggle[1])).run();
    return json({ ok: true });
  }
  const del = pathMatch(p2, /^\/admin\/users\/([^/]+)$/);
  if (del && req.method === "DELETE") {
    if (decodeURIComponent(del[1]) === user.uid) return error("\u4E0D\u80FD\u522A\u9664\u81EA\u5DF1", 400);
    await env.DB.prepare("DELETE FROM users WHERE uid=?").bind(decodeURIComponent(del[1])).run();
    return json({ ok: true });
  }
  return error("Not found", 404);
}
__name(admin, "admin");
async function api(req, env) {
  const url = new URL(req.url), p2 = url.pathname;
  if (url.searchParams.has("login_token")) return error("\u820A\u7248\u767B\u5165\u9023\u7D50\u5DF2\u5931\u6548\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165", 410);
  if (p2 === "/health") return json({ status: "ok", runtime: "cloudflare-native", gcp: false });
  if (p2 === "/config" && req.method === "GET") return json({ turnstile_site_key: String(env.TURNSTILE_SITE_KEY || "") });
  if (p2 === "/models") return json({ candidates: MODEL_CANDIDATES, judge_model: JUDGE_ALIAS, notes: MODEL_NOTES, disabled: [] });
  if (p2 === "/auth/turnstile/verify" && req.method === "POST") {
    const body = await req.json().catch(() => ({}));
    return verifyTurnstile(req, env, body?.token);
  }
  if (p2 === "/auth/request-link" || p2 === "/auth/verify") return error("Not found", 404);
  if (p2 === "/auth/saml/login" && req.method === "GET") return loginWithSaml(req, env);
  if (p2 === "/auth/saml/acs" && req.method === "POST") return handleAcs(req, env);
  if (p2 === "/auth/saml/acs") return json({ detail: "此端點只接受 IdP 以 HTTP-POST 送來的 SAMLResponse；請從 /auth/saml/login 開始登入" }, 405, { allow: "POST" });
  if ((p2 === "/auth/saml/metadata" || p2 === "/saml/metadata") && req.method === "GET") return handleSpMetadata(env);
  if (p2 === "/auth/logout" && req.method === "POST") return logout();
  if (p2 === "/chat/stream" && req.method === "POST") {
    const user = await authenticate(req, env, false), guest = req.headers.get("x-guest-id") || "";
    if (!user) {
      if (!/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
      const turnstileError = await requireTurnstile(req, env);
      if (turnstileError) return turnstileError;
    }
    // 訪客代號是瀏覽器自己產生的，換一個就是新的計數，所以訪客的每分鐘限流只看 IP。
    const key = user ? `chat:${user.uid}` : `chat:${clientIp(req)}`;
    if (await enforceRateLimit(env, key, CHAT_PER_MINUTE_LIMIT)) return error(`提問太頻繁：每分鐘最多 ${CHAT_PER_MINUTE_LIMIT} 題，請稍後再試`, 429);
    if (!user) {
      // 訪客最多問 GUEST_QUESTION_LIMIT 題；清掉瀏覽器資料就能換代號，所以另外限制每個 IP 每天的訪客題數。
      if (await enforceRateLimit(env, `guest-total:${guest}`, GUEST_QUESTION_LIMIT, FOREVER_SECONDS)) {
        return error(`已達訪客使用次數（最多 ${GUEST_QUESTION_LIMIT} 題），請使用學校帳號登入後繼續使用`, 429);
      }
      if (await enforceRateLimit(env, `guest-ip-day:${clientIp(req)}`, GUEST_IP_DAILY_LIMIT, 86400)) {
        return error("已達訪客使用次數（今天從這個網路發出的訪客提問已達上限），請使用學校帳號登入後繼續使用", 429);
      }
    }
    return streamChat(req, env, user);
  }
  if (p2 === "/me") {
    const u2 = await owner(req, env);
    const row = await env.DB.prepare("SELECT display_name,affiliation FROM users WHERE uid=?").bind(u2.uid).first();
    return json({ uid: u2.uid, email: u2.email, admin: u2.admin, display_name: row?.display_name || "", affiliation: row?.affiliation ? row.affiliation.split(",") : [] });
  }
  if (p2.startsWith("/conversations/") || p2 === "/conversations") return conversations(req, env, url);
  if (p2 === "/reset" && req.method === "POST") {
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    const u2 = await owner(req, env);
    await env.DB.prepare("DELETE FROM sessions WHERE uid=? AND session_id=?").bind(u2.uid, url.searchParams.get("session_id")).run();
    return json({ ok: true });
  }
  if (p2 === "/upload" && req.method === "POST") return upload(req, env);
  if (p2 === "/file-preview" && req.method === "GET") return preview(req, env, url);
  if (p2 === "/transcribe" && req.method === "POST") return transcribe(req, env);
  if (p2 === "/user/profile") {
    const u2 = await owner(req, env);
    if (req.method === "GET") {
      const x3 = await env.DB.prepare("SELECT system_prompt FROM profiles WHERE uid=?").bind(u2.uid).first();
      return json({ system_prompt: x3?.system_prompt || "" });
    }
    if (req.method !== "POST") return error("Method not allowed", 405);
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    const b3 = await req.json().catch(() => null);
    if (!b3) return error("\u8ACB\u6C42\u683C\u5F0F\u4E0D\u6B63\u78BA", 400);
    await env.DB.prepare("INSERT INTO profiles(uid,system_prompt) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET system_prompt=excluded.system_prompt").bind(u2.uid, String(b3.system_prompt || "").slice(0, 1e4)).run();
    return json({ ok: true });
  }
  if (p2 === "/user/memory") {
    const u2 = await owner(req, env);
    if (req.method === "GET") {
      const x3 = await env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(u2.uid).first();
      return json({ memory: x3?.memory || "" });
    }
    if (req.method !== "DELETE") return error("Method not allowed", 405);
    const sameOriginError = requireSameOrigin(req);
    if (sameOriginError) return sameOriginError;
    await env.DB.prepare("UPDATE profiles SET memory='',memory_updated_at=NULL WHERE uid=?").bind(u2.uid).run();
    return json({ ok: true });
  }
  if (p2 === "/feedback/session" && req.method === "POST") {
    const u2 = await authenticate(req, env, false);
    const guest = req.headers.get("x-guest-id") || "";
    if (!u2 && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
    const b3 = await req.json();
    const stats = u2?.uid || `guest:${guest}`;
    const count = u2 ? (await env.DB.prepare("SELECT question_count n FROM sessions WHERE uid=? AND session_id=?").bind(u2.uid, b3.session_id).first())?.n : (await env.DB.prepare("SELECT COUNT(*) n FROM usage_logs WHERE stats_uid=? AND session_id=?").bind(stats, b3.session_id).first())?.n;
    if (count < 3) return error("\u6B64\u5C0D\u8A71\u5C1A\u672A\u9054\u5230 3 \u500B\u554F\u984C\uFF0C\u4E0D\u80FD\u5217\u70BA\u6709\u6548 session", 400);
    await env.DB.prepare("INSERT INTO feedback(stats_uid,session_id,rating,is_guest,created_at,email,question_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(stats_uid,session_id) DO UPDATE SET rating=excluded.rating,created_at=excluded.created_at,email=excluded.email,question_count=excluded.question_count").bind(stats, b3.session_id, b3.rating, u2 ? 0 : 1, nowIso(), u2?.email || "", count).run();
    return json({ ok: true, question_count: count });
  }
  if (p2 === "/feedback/message") return messageFeedback(req, env, url);
  const shared = pathMatch(p2, /^\/share\/([^/]+)$/);
  if (shared && req.method === "GET") {
    const x3 = await env.DB.prepare("SELECT title,history_json FROM shares WHERE share_id=?").bind(shared[1]).first();
    return x3 ? json({ title: x3.title, history: safeJson(x3.history_json, []) }) : error("\u5206\u4EAB\u9023\u7D50\u4E0D\u5B58\u5728", 404);
  }
  if (p2.startsWith("/admin/")) return admin(req, env, url);
  return null;
}
__name(api, "api");
var index_default = { async fetch(req, env) {
  try {
    const response = await api(req, env);
    if (response) return await securityHeaders(response);
    const url = new URL(req.url);
    const assetRequest = ["/about", "/about/"].includes(url.pathname) ? new Request(new URL("/about.html", url), req) : req;
    return await securityHeaders(await env.ASSETS.fetch(assetRequest));
  } catch (e2) {
    if (e2 instanceof Response) return await securityHeaders(e2);
    console.error(e2);
    return await securityHeaders(error("\u7CFB\u7D71\u66AB\u6642\u7121\u6CD5\u56DE\u61C9", 500));
  }
} };
export {
  MESSAGE_FEEDBACK_REASONS,
  adminStats,
  index_default as default,
  hasUnsupportedTranscriptionScript,
  normalizeTranscription
};
//# sourceMappingURL=index.js.map
