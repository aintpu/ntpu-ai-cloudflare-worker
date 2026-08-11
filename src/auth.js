import { base64url, error, fromBase64url, json, nowIso, randomHex, sha256, uidFromEmail } from "./utils.js";

const enc = new TextEncoder();
const ALLOWED_DOMAINS = new Set(["gm.ntpu.edu.tw", "ms.ntpu.edu.tw", "mail.ntpu.edu.tw"]);

function allowedEmail(email, env) {
  const normalized = String(email || "").trim().toLowerCase();
  const domain = normalized.split("@")[1] || "";
  return ALLOWED_DOMAINS.has(domain) || normalized === String(env.ADMIN_EMAIL || "").toLowerCase();
}

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function signToken(payload, secret) {
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}

async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("invalid signature");
  const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("expired token");
  return payload;
}

export async function requestMagicLink(request, env) {
  if (!env.EMAIL) return error("Cloudflare Email Service 尚未設定", 503);
  const { email: rawEmail } = await request.json().catch(() => ({}));
  const email = String(rawEmail || "").trim().toLowerCase();
  if (!allowedEmail(email, env)) return error("僅限 NTPU 學校信箱登入", 403);
  const token = randomHex(32);
  const hash = await sha256(token);
  const expires = new Date(Date.now() + 15 * 60_000).toISOString();
  await env.DB.prepare("INSERT INTO magic_links(token_hash,email,expires_at) VALUES(?,?,?)")
    .bind(hash, email, expires).run();
  const origin = new URL(request.url).origin;
  const link = `${origin}/?login_token=${encodeURIComponent(token)}`;
  await env.EMAIL.send({
    from: { email: env.EMAIL_FROM || "noreply@ntpu.ai", name: "NTPU AI" },
    to: email,
    subject: "NTPU AI 登入連結（15 分鐘內有效）",
    html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto"><h2>NTPU AI 登入驗證</h2><p>請點擊下方按鈕完成登入。此連結只能使用一次，並將於 15 分鐘後失效。</p><p><a href="${link}" style="display:inline-block;background:#111;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none">登入 NTPU AI</a></p><p style="color:#666;font-size:13px">若你沒有提出登入要求，請忽略這封信。</p></div>`,
    text: `NTPU AI 登入連結（15 分鐘內有效）：\n${link}\n\n若你沒有提出登入要求，請忽略這封信。`,
  });
  return json({ ok: true });
}

export async function verifyMagicLink(request, env) {
  const { token } = await request.json().catch(() => ({}));
  const hash = await sha256(String(token || ""));
  const row = await env.DB.prepare("SELECT email,expires_at,used_at FROM magic_links WHERE token_hash=?").bind(hash).first();
  if (!row || row.used_at || Date.parse(row.expires_at) < Date.now()) return error("登入連結無效或已過期", 401);
  const email = row.email.toLowerCase();
  if (!allowedEmail(email, env)) return error("帳號不符合登入資格", 403);
  const uid = uidFromEmail(email);
  const now = nowIso();
  const admin = email === String(env.ADMIN_EMAIL || "").toLowerCase() ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare("UPDATE magic_links SET used_at=? WHERE token_hash=? AND used_at IS NULL").bind(now, hash),
    env.DB.prepare("INSERT INTO users(uid,email,is_admin,created_at,last_login_at) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET last_login_at=excluded.last_login_at,is_admin=MAX(users.is_admin,excluded.is_admin)").bind(uid, email, admin, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO profiles(uid) VALUES(?)").bind(uid),
  ]);
  const claims = { uid, email, admin: !!admin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 };
  return json({ token: await signToken(claims, env.AUTH_SECRET), user: claims });
}

export async function authenticate(request, env, required = true) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) { if (required) throw new Response(JSON.stringify({ detail: "Missing auth token" }), { status: 401, headers: { "content-type": "application/json" } }); return null; }
  try {
    const claims = await verifyToken(token, env.AUTH_SECRET);
    const user = await env.DB.prepare("SELECT is_admin FROM users WHERE uid=?").bind(claims.uid).first();
    if (!user) throw new Error("unknown user");
    return { ...claims, admin: !!user.is_admin };
  } catch {
    throw new Response(JSON.stringify({ detail: "登入已失效，請重新登入" }), { status: 401, headers: { "content-type": "application/json" } });
  }
}

export async function requireAdmin(request, env) {
  const user = await authenticate(request, env);
  if (!user.admin) throw new Response(JSON.stringify({ detail: "需要管理員權限" }), { status: 403, headers: { "content-type": "application/json" } });
  return user;
}
