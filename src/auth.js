import { base64url, error, fromBase64url, json, nowIso, uidFromEmail } from "./utils.js";
import { createRemoteJWKSet, jwtVerify } from "jose";

const enc = new TextEncoder();
const ALLOWED_DOMAINS = new Set(["gm.ntpu.edu.tw", "ms.ntpu.edu.tw", "mail.ntpu.edu.tw"]);
const accessKeySets = new Map();
const SESSION_COOKIE = "ntpu_ai_session";
const TURNSTILE_COOKIE = "ntpu_ai_turnstile";
const TURNSTILE_MAX_AGE = 300;

function turnstileEnabled(env) {
  return Boolean(String(env.TURNSTILE_SITE_KEY || "").trim());
}

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

function cookieValue(request, name) {
  const prefix = `${name}=`;
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return "";
}

function accessConfig(env) {
  const teamDomain = String(env.TEAM_DOMAIN || "").trim().replace(/\/$/, "");
  const audience = String(env.POLICY_AUD || "").trim();
  if (!teamDomain || !audience) throw new Error("Cloudflare Access 尚未設定 TEAM_DOMAIN 與 POLICY_AUD");
  return { teamDomain, audience };
}

async function verifyAccessIdentity(request, env) {
  const token = request.headers.get("cf-access-jwt-assertion") || "";
  if (!token) throw new Error("缺少 Cloudflare Access JWT");
  const { teamDomain, audience } = accessConfig(env);
  const certsUrl = `${teamDomain}/cdn-cgi/access/certs`;
  if (!accessKeySets.has(certsUrl)) accessKeySets.set(certsUrl, createRemoteJWKSet(new URL(certsUrl)));
  const { payload } = await jwtVerify(token, accessKeySets.get(certsUrl), {
    issuer: teamDomain,
    audience,
    algorithms: ["RS256"],
  });
  const email = String(payload.email || "").trim().toLowerCase();
  if (payload.type !== "app" || !email) throw new Error("Cloudflare Access JWT 沒有有效的使用者身分");
  if (!allowedEmail(email, env)) throw new Error("僅限 NTPU 校內帳號登入");
  return { email, accessSub: String(payload.sub || "") };
}

async function upsertUserAndIssueToken(email, env) {
  const now = nowIso();
  const uid = uidFromEmail(email);
  const admin = email === String(env.ADMIN_EMAIL || "").toLowerCase() ? 1 : 0;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(uid,email,is_admin,created_at,last_login_at) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET last_login_at=excluded.last_login_at,is_admin=MAX(users.is_admin,excluded.is_admin)").bind(uid, email, admin, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO profiles(uid) VALUES(?)").bind(uid),
  ]);
  const claims = { uid, email, admin: !!admin, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 7 * 86400 };
  return { claims, token: await signToken(claims, env.AUTH_SECRET) };
}

async function issueTurnstileToken(env) {
  return signToken({
    type: "turnstile",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + TURNSTILE_MAX_AGE,
  }, env.AUTH_SECRET);
}

export async function verifyTurnstile(request, env, token) {
  if (!turnstileEnabled(env)) return json({ ok: true, enabled: false });
  if (!String(env.TURNSTILE_SECRET_KEY || "").trim()) return error("Turnstile 尚未完成伺服器設定", 503);
  const responseToken = String(token || "").trim();
  if (!responseToken || responseToken.length > 2048) return error("請先完成安全驗證", 400);
  const form = new URLSearchParams();
  form.set("secret", String(env.TURNSTILE_SECRET_KEY));
  form.set("response", responseToken);
  const ip = request.headers.get("cf-connecting-ip");
  if (ip) form.set("remoteip", ip);
  let result;
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    result = await response.json();
  } catch (cause) {
    console.error("Turnstile Siteverify request failed", cause);
    return error("安全驗證服務暫時無法使用，請稍後再試", 502);
  }
  if (!result?.success) {
    console.warn("Turnstile validation failed", result?.["error-codes"] || []);
    return error("安全驗證失敗，請重新勾選後再試", 403);
  }
  const signed = await issueTurnstileToken(env);
  return json({ ok: true, enabled: true }, 200, {
    "set-cookie": `${TURNSTILE_COOKIE}=${encodeURIComponent(signed)}; Path=/; Max-Age=${TURNSTILE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    "cache-control": "no-store",
  });
}

async function validTurnstileCookie(request, env) {
  if (!turnstileEnabled(env)) return true;
  const token = cookieValue(request, TURNSTILE_COOKIE);
  if (!token) return false;
  try {
    const claims = await verifyToken(token, env.AUTH_SECRET);
    return claims.type === "turnstile";
  } catch {
    return false;
  }
}

export async function requireTurnstile(request, env) {
  if (!turnstileEnabled(env)) return null;
  if (await validTurnstileCookie(request, env)) return null;
  return error("請先完成 Cloudflare 安全驗證", 403);
}

export async function loginWithAccess(request, env) {
  try {
    const turnstileError = await requireTurnstile(request, env);
    if (turnstileError) return turnstileError;
    const { email } = await verifyAccessIdentity(request, env);
    const { token } = await upsertUserAndIssueToken(email, env);
    return new Response(null, {
      status: 302,
      headers: {
        location: "/",
        "cache-control": "no-store",
        "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax`,
      },
    });
  } catch (cause) {
    console.error("Cloudflare Access login failed", cause);
    return error(cause instanceof Error ? cause.message : "Cloudflare Access 驗證失敗", 403);
  }
}

export function logout() {
  return json({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    "cache-control": "no-store",
  });
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

export async function authenticate(request, env, required = true) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || cookieValue(request, SESSION_COOKIE);
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
