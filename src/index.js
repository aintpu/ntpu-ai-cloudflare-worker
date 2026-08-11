import { authenticate, requestMagicLink, requireAdmin, verifyMagicLink } from "./auth.js";
import { streamChat } from "./chat.js";
import { aesDecrypt, error, json, nowIso, randomHex, safeJson, securityHeaders, sha256 } from "./utils.js";

const MODEL = "gpt-5.6-luna";
const owner = async (req, env) => authenticate(req, env);
const pathMatch = (path, re) => path.match(re);

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
  const status = pathMatch(path, /^\/conversations\/([^/]+)\/memory-status$/); if (status) return json({ pending_since: null, interval_hours: 3 });
  const compress = pathMatch(path, /^\/conversations\/([^/]+)\/memory-compress-now$/); if (compress) return json({ ok: true });
  const share = pathMatch(path, /^\/conversations\/([^/]+)\/share$/); if (share) {
    const sid = decodeURIComponent(share[1]); const row = await env.DB.prepare("SELECT title,history_json FROM sessions WHERE uid=? AND session_id=?").bind(user.uid, sid).first();
    if (!row) return error("對話不存在", 404); const id = randomHex(12); await env.DB.prepare("INSERT INTO shares VALUES(?,?,?,?,?,?)").bind(id, user.uid, sid, row.title, row.history_json, nowIso()).run(); return json({ share_id: id });
  }
  return error("Not found", 404);
}

async function upload(req, env) {
  const user = await authenticate(req, env, false); const guest = req.headers.get("x-guest-id") || "";
  if (!user && !/^[a-f0-9]{32}$/.test(guest)) return error("Missing auth token or guest ID", 401);
  const form = await req.formData(); const file = form.get("file"); if (!(file instanceof File)) return error("缺少檔案", 400); if (file.size > 20 * 1024 * 1024) return error("檔案超過 20MB 上限", 413);
  const ext = (file.name.match(/\.[A-Za-z0-9]{1,10}$/)?.[0] || "").toLowerCase(); const prefix = user ? `uploads/${user.uid}` : `uploads/guests/${guest}`; const key = `${prefix}/${Date.now()}_${randomHex(4)}${ext}`;
  await env.UPLOADS.put(key, file.stream(), { httpMetadata: { contentType: file.type || "application/octet-stream" }, customMetadata: { filename: file.name } });
  return json({ gcs_path: key, filename: file.name, mime_type: file.type, size: file.size });
}

async function preview(req, env, url) {
  const user = await authenticate(req, env, false); const guest = req.headers.get("x-guest-id") || ""; const key = url.searchParams.get("path") || "";
  const prefix = user ? `uploads/${user.uid}/` : `uploads/guests/${guest}/`; if (!key.startsWith(prefix)) return error("無法存取此附件", 403);
  const object = await env.UPLOADS.get(key); if (!object) return error("檔案不存在", 404); const headers = new Headers(); object.writeHttpMetadata(headers); headers.set("etag", object.httpEtag); const type = headers.get("content-type") || "application/octet-stream"; if (/html|svg/.test(type)) headers.set("content-type", "text/plain; charset=utf-8"); return new Response(object.body, { headers });
}

async function transcribe(req, env) {
  await owner(req, env); const form = await req.formData(); const file = form.get("file"); if (!(file instanceof File)) return error("缺少音檔", 400);
  const out = new FormData(); out.append("file", file, file.name || "audio.webm"); out.append("model", "gpt-4o-mini-transcribe"); out.append("language", String(form.get("lang") || "zh").startsWith("zh") ? "zh" : "en");
  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", { method: "POST", headers: { authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: out }); if (!response.ok) return error("語音轉文字失敗", 502); return new Response(response.body, { headers: { "content-type": "application/json" } });
}

async function admin(req, env, url) {
  const user = await requireAdmin(req, env); const p = url.pathname;
  if (p === "/admin/setup") return json({ ok: true });
  if (p === "/admin/config") { if (req.method === "GET") { const row = await env.DB.prepare("SELECT value_json FROM app_config WHERE key='routing'").first(); return json(safeJson(row?.value_json || "{}", {})); } const body = await req.json(); await env.DB.prepare("INSERT INTO app_config VALUES('routing',?,?) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at").bind(JSON.stringify(body), nowIso()).run(); return json({ ok: true }); }
  if (p === "/admin/stats") {
    const start = url.searchParams.get("start") || new Date(Date.now() - 30 * 86400000).toISOString(), end = url.searchParams.get("end") || nowIso(); const rows = await env.DB.prepare("SELECT * FROM usage_logs WHERE created_at BETWEEN ? AND ? ORDER BY created_at DESC").bind(start, end).all(); const logs = rows.results || []; return json({ total_requests: logs.length, total_input_tokens: logs.reduce((n,x)=>n+x.input_tokens,0), total_output_tokens: logs.reduce((n,x)=>n+x.output_tokens,0), logs });
  }
  const reveal = pathMatch(p, /^\/admin\/guest-id\/(guest:[a-z0-9_-]{16})$/i); if (reveal) { const row = await env.DB.prepare("SELECT guest_id_encrypted FROM usage_logs WHERE stats_uid=? AND guest_id_encrypted<>'' ORDER BY id DESC LIMIT 1").bind(reveal[1]).first(); if (!row) return error("找不到識別碼",404); return json({ stats_uid: reveal[1], guest_id: await aesDecrypt(row.guest_id_encrypted, env.GUEST_ID_ENCRYPTION_KEY, reveal[1]) }); }
  if (p === "/admin/users" && req.method === "GET") { const rows = await env.DB.prepare("SELECT uid,email,is_admin,created_at,last_login_at FROM users ORDER BY created_at DESC").all(); return json(rows.results || []); }
  const toggle = pathMatch(p, /^\/admin\/users\/([^/]+)\/toggle-admin$/); if (toggle) { await env.DB.prepare("UPDATE users SET is_admin=? WHERE uid=?").bind(url.searchParams.get("is_admin") === "true" ? 1 : 0, decodeURIComponent(toggle[1])).run(); return json({ ok:true }); }
  const del = pathMatch(p, /^\/admin\/users\/([^/]+)$/); if (del && req.method === "DELETE") { if (decodeURIComponent(del[1]) === user.uid) return error("不能刪除自己",400); await env.DB.prepare("DELETE FROM users WHERE uid=?").bind(decodeURIComponent(del[1])).run(); return json({ok:true}); }
  return error("Not found", 404);
}

async function api(req, env) {
  const url = new URL(req.url), p = url.pathname;
  if (p === "/health") return json({ status: "ok", runtime: "cloudflare-native", gcp: false });
  if (p === "/models") { const model = env.OPENAI_MODEL || MODEL; return json({ candidates: { default: [model], small: [model], medium: [model], large: [model] }, notes: { [model]: "NTPU AI 預設模型" }, disabled: [] }); }
  if (p === "/auth/request-link" && req.method === "POST") return requestMagicLink(req, env);
  if (p === "/auth/verify" && req.method === "POST") return verifyMagicLink(req, env);
  if (p === "/chat/stream" && req.method === "POST") return streamChat(req, env, await authenticate(req, env, false));
  if (p === "/me") { const u = await owner(req,env); return json({uid:u.uid,email:u.email,admin:u.admin}); }
  if (p.startsWith("/conversations/" ) || p === "/conversations") return conversations(req,env,url);
  if (p === "/reset" && req.method === "POST") { const u=await owner(req,env); await env.DB.prepare("DELETE FROM sessions WHERE uid=? AND session_id=?").bind(u.uid,url.searchParams.get("session_id")).run(); return json({ok:true}); }
  if (p === "/upload" && req.method === "POST") return upload(req,env); if (p === "/file-preview") return preview(req,env,url); if (p === "/transcribe" && req.method === "POST") return transcribe(req,env);
  if (p === "/user/profile") { const u=await owner(req,env); if(req.method==="GET"){const x=await env.DB.prepare("SELECT system_prompt FROM profiles WHERE uid=?").bind(u.uid).first();return json({system_prompt:x?.system_prompt||""});} const b=await req.json();await env.DB.prepare("INSERT INTO profiles(uid,system_prompt) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET system_prompt=excluded.system_prompt").bind(u.uid,String(b.system_prompt||"").slice(0,10000)).run();return json({ok:true}); }
  if (p === "/user/memory") { const u=await owner(req,env); if(req.method==="GET"){const x=await env.DB.prepare("SELECT memory FROM profiles WHERE uid=?").bind(u.uid).first();return json({memory:x?.memory||""});} await env.DB.prepare("UPDATE profiles SET memory='',memory_updated_at=NULL WHERE uid=?").bind(u.uid).run();return json({ok:true}); }
  if (p === "/feedback/session" && req.method === "POST") { const u=await authenticate(req,env,false); const guest=req.headers.get("x-guest-id")||""; if(!u&&!/^[a-f0-9]{32}$/.test(guest))return error("Missing auth token or guest ID",401); const b=await req.json(); const stats=u?.uid || `guest:${(await sha256(guest)).slice(0,16).toLowerCase()}`; const count=u?(await env.DB.prepare("SELECT question_count n FROM sessions WHERE uid=? AND session_id=?").bind(u.uid,b.session_id).first())?.n:(await env.DB.prepare("SELECT COUNT(*) n FROM usage_logs WHERE stats_uid=? AND session_id=?").bind(stats,b.session_id).first())?.n; if(count<3)return error("至少完成 3 個問題才能評分",400);await env.DB.prepare("INSERT INTO feedback VALUES(?,?,?,?,?) ON CONFLICT(stats_uid,session_id) DO UPDATE SET rating=excluded.rating,created_at=excluded.created_at").bind(stats,b.session_id,b.rating,u?0:1,nowIso()).run();return json({ok:true}); }
  const shared=pathMatch(p,/^\/share\/([^/]+)$/); if(shared){const x=await env.DB.prepare("SELECT title,history_json FROM shares WHERE share_id=?").bind(shared[1]).first();return x?json({title:x.title,history:safeJson(x.history_json,[])}):error("分享連結不存在",404);}
  if (p.startsWith("/admin/")) return admin(req,env,url);
  return null;
}

export default { async fetch(req, env) { try { const response = await api(req,env); return securityHeaders(response || await env.ASSETS.fetch(req)); } catch (e) { if (e instanceof Response) return securityHeaders(e); console.error(e); return securityHeaders(error("系統暫時無法回應",500)); } } };
