import { authenticate, requestMagicLink, requireAdmin, verifyMagicLink } from "./auth.js";
import { compressMemory, streamChat } from "./chat.js";
import { extractOfficeText, OFFICE_MIMES } from "./office.js";
import { JUDGE_ALIAS, MODEL_CANDIDATES, MODEL_NOTES, MODEL_TO_ROUTE } from "./models.js";
import { aesDecrypt, error, json, nowIso, randomHex, safeJson, securityHeaders, sha256 } from "./utils.js";

const owner = async (req, env) => authenticate(req, env);
const pathMatch = (path, re) => path.match(re);

async function enforceRateLimit(env, key, limit, windowSeconds = 60) {
  const windowStart = Math.floor(Date.now() / 1000 / windowSeconds) * windowSeconds;
  const row = await env.DB.prepare(`
    INSERT INTO rate_limits(limiter_key,window_start,request_count) VALUES(?,?,1)
    ON CONFLICT(limiter_key,window_start) DO UPDATE SET request_count=request_count+1
    RETURNING request_count
  `).bind(key, windowStart).first();
  if ((row?.request_count || 1) > limit) return error("請求過於頻繁，請稍後再試", 429);
  return null;
}

function clientIp(req) {
  return req.headers.get("cf-connecting-ip") || "unknown";
}

async function conversations(req, env, url) {
  const user = await owner(req, env); const path = url.pathname;
  if (path === "/conversations") {
    const rows = await env.DB.prepare("SELECT session_id,title,updated_at FROM sessions WHERE uid=? ORDER BY updated_at DESC LIMIT 100").bind(user.uid).all();
    return json(rows.results || []);
  }
  const m = pathMatch(path, /^\/conversations\/([^/]+)$/); if (m) {
    const row = await env.DB.prepare("SELECT title,history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, decodeURIComponent(m[1])).first();
    if (!row) return error("對話不存在", 404); return json({ session_id: decodeURIComponent(m[1]), title: row.title, history: safeJson(row.history_json, []) });
  }
  const status = pathMatch(path, /^\/conversations\/([^/]+)\/memory-status$/); if (status) {
    const sid = decodeURIComponent(status[1]);
    const row = await env.DB.prepare("SELECT memory_pending_since FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    return json({ pending_since: row?.memory_pending_since || null, interval_hours: 3 });
  }
  const compress = pathMatch(path, /^\/conversations\/([^/]+)\/memory-compress-now$/); if (compress && req.method === "POST") {
    const sid = decodeURIComponent(compress[1]);
    const row = await env.DB.prepare("SELECT history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    const history = safeJson(row?.history_json || "[]", []);
    if (!history.length) return error("對話不存在，沒有內容可以更新", 404);
    await compressMemory(env, user.uid, sid, history);
    return json({ ok: true });
  }
  const share = pathMatch(path, /^\/conversations\/([^/]+)\/share$/); if (share) {
    const sid = decodeURIComponent(share[1]); const row = await env.DB.prepare("SELECT title,history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    if (!row) return error("對話不存在", 404); const id = randomHex(12); await env.DB.prepare("INSERT INTO shares VALUES(?,?,?,?,?,?)").bind(id, user.uid, sid, row.title, row.history_json, nowIso()).run(); return json({ share_id: id });
  }
  return error("Not found", 404);
}

async function upload(req, env) {
  const user = await authenticate(req, env, false); const guest = req.headers.get("x-guest-id") || "";
  if (!user && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
  const limited = await enforceRateLimit(env, `upload:${user?.uid || `${clientIp(req)}:${guest}`}`, 10);
  if (limited) return limited;
  const form = await req.formData(); const file = form.get("file"); if (!(file instanceof File)) return error("缺少檔案", 400); if (file.size > 20 * 1024 * 1024) return error("檔案超過 20MB 上限", 413);
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || "").toLowerCase(); const prefix = user ? `uploads/${user.uid}` : `uploads/guests/${guest}`; const key = `${prefix}/${Date.now()}_${randomHex(4)}${ext}`;
  await env.UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { filename: file.name } });
  return json({ gcs_path: key, filename: file.name, mime_type: file.type, size: file.size });
}

async function preview(req, env, url) {
  const user = await authenticate(req, env, false); const guest = req.headers.get("x-guest-id") || ""; const key = url.searchParams.get("path") || "";
  const prefix = user ? `uploads/${user.uid}/` : `uploads/guests/${guest}/`; if (!key.startsWith(prefix)) return error("無法存取此附件", 403);
  const object = await env.UPLOADS.get(key); if (!object) return error("檔案不存在", 404); const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); const type = headers.get("content-type") || "application/octet-stream";
  if (OFFICE_MIMES.has(type)) {
    const text = extractOfficeText(new Uint8Array(await object.arrayBuffer()), type);
    return new Response(text || "（無法取出文字內容）", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  if (/html|svg/.test(type) || type.startsWith("text/")) headers.set("content-type", "text/plain; charset=utf-8");
  if (!type.startsWith("image/") && !type.startsWith("audio/") && !type.startsWith("video/") && type !== "application/pdf" && !type.startsWith("text/")) headers.set("content-disposition", "attachment");
  return new Response(object.body, { headers });
}

async function transcribe(req, env) {
  const user = await owner(req, env); const limited = await enforceRateLimit(env, `upload:${user.uid}`, 10); if (limited) return limited;
  const form = await req.formData(); const file = form.get("file"); if (!(file instanceof File)) return error("缺少音檔", 400); if (file.size > 25 * 1024 * 1024) return error("音檔過大（上限 25 MB）", 413);
  const out = new FormData(); out.append("file", file, file.name || "audio.webm"); out.append("model", "whisper-1"); out.append("language", String(form.get("lang") || "zh").startsWith("zh") ? "zh" : "en");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: out }); if (!response.ok) return error("語音轉文字失敗", 502); return new Response(response.body, { headers: { "content-type": "application/json" } });
}

export async function adminStats(env, url) {
  const start = url.searchParams.get("start") || new Date(Date.now() - 30 * 86400000).toISOString();
  const end = url.searchParams.get("end") || nowIso();
  const [usageResult, feedbackResult] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM usage_logs WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20000").bind(start, end),
    env.DB.prepare("SELECT * FROM feedback WHERE created_at>=? AND created_at<? ORDER BY created_at DESC LIMIT 20000").bind(start, end),
  ]);
  const userMap = new Map(), sessionMap = new Map(), modelMap = new Map();
  for (const row of usageResult.results || []) {
    if (!userMap.has(row.stats_uid)) userMap.set(row.stats_uid, { uid: row.stats_uid, email: row.email || "", is_guest: row.access_type === "guest" || row.stats_uid.startsWith("guest:"), total: 0, conversations: 0, small: 0, medium: 0, large: 0, tiny: 0, input_tokens: 0, output_tokens: 0 });
    const user = userMap.get(row.stats_uid); user.total++; user.input_tokens += row.input_tokens || 0; user.output_tokens += row.output_tokens || 0;
    if (["small","medium","large","tiny"].includes(row.route)) user[row.route]++;
    const sessionKey = `${row.stats_uid}\u0000${row.session_id}`; sessionMap.set(sessionKey, (sessionMap.get(sessionKey) || 0) + 1);
    const addModel = (name, input, output) => {
      if (!name) return;
      if (!modelMap.has(name)) modelMap.set(name, { model:name, requests:0, input_tokens:0, output_tokens:0 });
      const item=modelMap.get(name); item.requests++; item.input_tokens+=input||0; item.output_tokens+=output||0;
    };
    if (row.judge_model) {
      addModel(row.judge_model, row.judge_input_tokens, row.judge_output_tokens);
      addModel(row.model, row.answer_input_tokens, row.answer_output_tokens);
    } else addModel(row.model, row.input_tokens, row.output_tokens);
  }
  for (const [key, count] of sessionMap) if (count >= 3) userMap.get(key.split("\u0000")[0]).conversations++;
  const users = [...userMap.values()].sort((a,b) => b.total-a.total);
  const by_model = [...modelMap.values()].sort((a,b) => (b.input_tokens+b.output_tokens)-(a.input_tokens+a.output_tokens));
  const distribution = { "1":0,"2":0,"3":0,"4":0,"5":0 }; let sum=0, positive=0;
  const feedback = (feedbackResult.results || []).filter(x => x.rating>=1 && x.rating<=5).map(x => { distribution[String(x.rating)]++; sum+=x.rating; if(x.rating>=4)positive++; return { uid:x.stats_uid,email:x.email||"",is_guest:!!x.is_guest,session_id:x.session_id,rating:x.rating,question_count:x.question_count||0,timestamp:x.created_at }; });
  const responses=feedback.length, validSessions=users.reduce((n,u)=>n+u.conversations,0);
  return { users, by_model, satisfaction: { responses, average: responses ? Math.round(sum/responses*100)/100 : 0, csat_percent: responses ? Math.round(positive*1000/responses)/10 : 0, response_rate: validSessions ? Math.min(100,Math.round(responses*1000/validSessions)/10) : 0, distribution }, feedback };
}

async function admin(req, env, url) {
  const user = await requireAdmin(req, env); const p = url.pathname;
  if (p === "/admin/setup") return json({ ok: true });
  if (p === "/admin/config") { if (req.method === "GET") { const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE key='routing'").first(); return json({threshold_tiny:null,threshold_medium:4,threshold_large:7,force_model:null,prefer_local:false,...safeJson(row?.value_json || "{}", {})}); } const body = await req.json(); const force=body.force_model; if(force && !["small","medium","large","tiny"].includes(force) && !MODEL_TO_ROUTE[force])return error(`模型 ${force} 尚未在目前環境註冊`,400); await env.DB.prepare("INSERT INTO app_config VALUES('routing',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(JSON.stringify(body), nowIso()).run(); return json({ ok: true }); }
  if (p === "/admin/stats") return json(await adminStats(env, url));
  const reveal = pathMatch(p, /^\/admin\/guest-id\/(guest:[a-z0-9_-]{16})$/i); if (reveal) { const row = await env.DB.prepare("SELECT guest_id_encrypted FROM usage_logs WHERE stats_uid=? AND guest_id_encrypted<>'' ORDER BY id DESC LIMIT 1").bind(reveal[1]).first(); if (!row) return error("找不到識別碼",404); return json({ stats_uid: reveal[1], guest_id: await aesDecrypt(row.guest_id_encrypted, env.GUEST_ID_ENCRYPTION_KEY, reveal[1]) }); }
  if (p === "/admin/users" && req.method === "GET") { const rows = await env.DB.prepare("SELECT uid,email,is_admin,created_at,last_login_at FROM users ORDER BY created_at DESC").all(); return json(rows.results || []); }
  const toggle = pathMatch(p, /^\/admin\/users\/([^/]+)\/toggle-admin$/); if (toggle) { await env.DB.prepare("UPDATE users SET is_admin=? WHERE uid=?").bind(url.searchParams.get("is_admin") === "true" ? 1 : 0, decodeURIComponent(toggle[1])).run(); return json({ ok:true }); }
  const del = pathMatch(p, /^\/admin\/users\/([^/]+)$/); if (del && req.method === "DELETE") { if (decodeURIComponent(del[1]) === user.uid) return error("不能刪除自己",400); await env.DB.prepare("DELETE FROM users WHERE uid=?").bind(decodeURIComponent(del[1])).run(); return json({ok:true}); }
  return error("Not found", 404);
}

async function api(req, env) {
  const url = new URL(req.url), p = url.pathname;
  if (p === "/health") return json({ status: "ok", runtime: "cloudflare-native", gcp: false });
  if (p === "/models") return json({ candidates:MODEL_CANDIDATES, judge_model:JUDGE_ALIAS, notes:MODEL_NOTES, disabled:[] });
  if (p === "/auth/request-link" && req.method === "POST") {
    const limited = await enforceRateLimit(env, `login:${clientIp(req)}`, 5, 600);
    return limited || requestMagicLink(req, env);
  }
  if (p === "/auth/verify" && req.method === "POST") return verifyMagicLink(req, env);
  if (p === "/chat/stream" && req.method === "POST") {
    const user = await authenticate(req, env, false), guest = req.headers.get("x-guest-id") || "";
    const key = user ? `chat:${user.uid}` : `chat:${clientIp(req)}:${guest}`;
    const limited = await enforceRateLimit(env, key, user ? 20 : 5);
    return limited || streamChat(req, env, user);
  }
  if (p === "/me") { const u = await owner(req,env); return json({uid:u.uid,email:u.email,admin:u.admin}); }
  if (p.startsWith("/conversations/" ) || p === "/conversations") return conversations(req,env,url);
  if (p === "/reset" && req.method === "POST") { const u=await owner(req,env); await env.DB.prepare("DELETE FROM sessions WHERE uid=? AND session_id=?").bind(u.uid,url.searchParams.get("session_id")).run(); return json({ok:true}); }
  if (p === "/upload" && req.method === "POST") return upload(req,env); if (p === "/file-preview") return preview(req,env,url); if (p === "/transcribe" && req.method === "POST") return transcribe(req,env);
  if (p === "/user/profile") { const u=await owner(req,env); if(req.method==="GET"){const x=await env.DB.prepare("SELECT system_prompt FROM profiles WHERE uid=?").bind(u.uid).first();return json({system_prompt:x?.system_prompt||""});} const b=await req.json();await env.DB.prepare("INSERT INTO profiles(uid,system_prompt) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET system_prompt=excluded.system_prompt").bind(u.uid,String(b.system_prompt||"").slice(0,10000)).run();return json({ok:true}); }
  if (p === "/user/memory") { const u=await owner(req,env); if(req.method==="GET"){const x=await env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(u.uid).first();return json({memory:x?.memory||""});} await env.DB.prepare("UPDATE profiles SET memory='',memory_updated_at=NULL WHERE uid=?").bind(u.uid).run();return json({ok:true}); }
  if (p === "/feedback/session" && req.method === "POST") { const u=await authenticate(req,env,false); const guest=req.headers.get("x-guest-id")||""; if(!u&&!/^[a-f0-9]{32}$/.test(guest))return error("Missing auth token or guest ID",401); const b=await req.json(); const stats=u?.uid || `guest:${(await sha256(guest)).slice(0,16).toLowerCase()}`; const count=u?(await env.DB.prepare("SELECT question_count n FROM sessions WHERE uid=? AND session_id=?").bind(u.uid,b.session_id).first())?.n:(await env.DB.prepare("SELECT COUNT(*) n FROM usage_logs WHERE stats_uid=? AND session_id=?").bind(stats,b.session_id).first())?.n; if(count<3)return error("此對話尚未達到 3 個問題，不能列為有效 session",400);await env.DB.prepare("INSERT INTO feedback(stats_uid,session_id,rating,is_guest,created_at,email,question_count) VALUES(?,?,?,?,?,?,?) ON CONFLICT(stats_uid,session_id) DO UPDATE SET rating=excluded.rating,created_at=excluded.created_at,email=excluded.email,question_count=excluded.question_count").bind(stats,b.session_id,b.rating,u?0:1,nowIso(),u?.email||"",count).run();return json({ok:true,question_count:count}); }
  const shared=pathMatch(p,/^\/share\/([^/]+)$/); if(shared){const x=await env.DB.prepare("SELECT title,history_json FROM shares WHERE share_id=?").bind(shared[1]).first();return x?json({title:x.title,history:safeJson(x.history_json,[])}):error("分享連結不存在",404);}
  if (p.startsWith("/admin/")) return admin(req,env,url);
  return null;
}

export default { async fetch(req, env) { try { const response = await api(req,env); return securityHeaders(response || await env.ASSETS.fetch(req)); } catch (e) { if (e instanceof Response) return securityHeaders(e); console.error(e); return securityHeaders(error("系統暫時無法回應",500)); } } };
