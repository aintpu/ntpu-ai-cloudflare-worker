import { __name, base64url, fromBase64url, json, error, nowIso, uidFromEmail, cookieValue } from "./utils.js";

var enc = new TextEncoder();
var SESSION_COOKIE = "ntpu_ai_session";
// 登出只會清掉本站的登入，學校 SSO 仍記得使用者；留下這個標記，下次登入就要求 IdP 重新輸入帳密（ForceAuthn），才能換帳號。
export var SAML_REAUTH_COOKIE = "ntpu_ai_saml_reauth";
var TURNSTILE_COOKIE = "ntpu_ai_turnstile";
var TURNSTILE_MAX_AGE = 300;
function turnstileEnabled(env) {
  return Boolean(String(env.TURNSTILE_SITE_KEY || "").trim());
}
__name(turnstileEnabled, "turnstileEnabled");
async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
__name(hmacKey, "hmacKey");
export async function signToken(payload, secret) {
  const header = base64url(enc.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = base64url(enc.encode(JSON.stringify(payload)));
  const input = `${header}.${body}`;
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(input));
  return `${input}.${base64url(new Uint8Array(signature))}`;
}
__name(signToken, "signToken");
// 登入一律由學校 SSO 驗證；sso 是 { displayName, affiliation }，每次登入都更新。
// 管理員權限只能從後台設定：mail 可能是使用者自填的信箱，不能靠它自動取得管理員。
export async function upsertUserAndIssueToken(email, env, sso) {
  const now = nowIso();
  const existing = await env.DB.prepare("SELECT uid,is_admin FROM users WHERE email=?").bind(email).first();
  const uid = existing?.uid || uidFromEmail(email);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users(uid,email,is_admin,created_at,last_login_at) VALUES(?,?,0,?,?) ON CONFLICT(uid) DO UPDATE SET last_login_at=excluded.last_login_at").bind(uid, email, now, now),
    env.DB.prepare("INSERT OR IGNORE INTO profiles(uid) VALUES(?)").bind(uid),
    env.DB.prepare("UPDATE users SET display_name=?,affiliation=? WHERE uid=?").bind(sso.displayName, sso.affiliation.join(","), uid)
  ]);
  const claims = { uid, email, admin: !!existing?.is_admin, iat: Math.floor(Date.now() / 1e3), exp: Math.floor(Date.now() / 1e3) + 7 * 86400 };
  return { claims, token: await signToken(claims, env.AUTH_SECRET) };
}
__name(upsertUserAndIssueToken, "upsertUserAndIssueToken");
async function issueTurnstileToken(env) {
  return signToken({
    type: "turnstile",
    iat: Math.floor(Date.now() / 1e3),
    exp: Math.floor(Date.now() / 1e3) + TURNSTILE_MAX_AGE
  }, env.AUTH_SECRET);
}
__name(issueTurnstileToken, "issueTurnstileToken");
export async function verifyTurnstile(request, env, token) {
  if (!turnstileEnabled(env)) return json({ ok: true, enabled: false });
  if (!String(env.TURNSTILE_SECRET_KEY || "").trim()) return error("Turnstile \u5C1A\u672A\u5B8C\u6210\u4F3A\u670D\u5668\u8A2D\u5B9A", 503);
  const responseToken = String(token || "").trim();
  if (!responseToken || responseToken.length > 2048) return error("\u8ACB\u5148\u5B8C\u6210\u5B89\u5168\u9A57\u8B49", 400);
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
      body: form
    });
    result = await response.json();
  } catch (cause) {
    console.error("Turnstile Siteverify request failed", cause);
    return error("\u5B89\u5168\u9A57\u8B49\u670D\u52D9\u66AB\u6642\u7121\u6CD5\u4F7F\u7528\uFF0C\u8ACB\u7A0D\u5F8C\u518D\u8A66", 502);
  }
  if (!result?.success) {
    console.warn("Turnstile validation failed", result?.["error-codes"] || []);
    return error("\u5B89\u5168\u9A57\u8B49\u5931\u6557\uFF0C\u8ACB\u91CD\u65B0\u52FE\u9078\u5F8C\u518D\u8A66", 403);
  }
  const signed = await issueTurnstileToken(env);
  return json({ ok: true, enabled: true }, 200, {
    "set-cookie": `${TURNSTILE_COOKIE}=${encodeURIComponent(signed)}; Path=/; Max-Age=${TURNSTILE_MAX_AGE}; HttpOnly; Secure; SameSite=Lax`,
    "cache-control": "no-store"
  });
}
__name(verifyTurnstile, "verifyTurnstile");
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
__name(validTurnstileCookie, "validTurnstileCookie");
export async function requireTurnstile(request, env) {
  if (!turnstileEnabled(env)) return null;
  if (await validTurnstileCookie(request, env)) return null;
  return error("\u8ACB\u5148\u5B8C\u6210 Cloudflare \u5B89\u5168\u9A57\u8B49", 403);
}
__name(requireTurnstile, "requireTurnstile");
export function sessionCookieHeader(token) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${7 * 86400}; HttpOnly; Secure; SameSite=Lax`;
}
__name(sessionCookieHeader, "sessionCookieHeader");
export function logout() {
  const response = json({ ok: true }, 200, {
    "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
    "cache-control": "no-store"
  });
  response.headers.append("set-cookie", `${SAML_REAUTH_COOKIE}=1; Path=/; Max-Age=${30 * 86400}; HttpOnly; Secure; SameSite=Lax`);
  return response;
}
__name(logout, "logout");
export async function verifyToken(token, secret) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) throw new Error("invalid token");
  const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64url(parts[2]), enc.encode(`${parts[0]}.${parts[1]}`));
  if (!valid) throw new Error("invalid signature");
  const payload = JSON.parse(new TextDecoder().decode(fromBase64url(parts[1])));
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1e3)) throw new Error("expired token");
  return payload;
}
__name(verifyToken, "verifyToken");
export async function authenticate(request, env, required = true) {
  const auth = request.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const token = bearer || cookieValue(request, SESSION_COOKIE);
  if (!token) {
    if (required) throw new Response(JSON.stringify({ detail: "Missing auth token" }), { status: 401, headers: { "content-type": "application/json" } });
    return null;
  }
  try {
    const claims = await verifyToken(token, env.AUTH_SECRET);
    const user = await env.DB.prepare("SELECT is_admin FROM users WHERE uid=?").bind(claims.uid).first();
    if (!user) throw new Error("unknown user");
    return { ...claims, admin: !!user.is_admin };
  } catch {
    throw new Response(JSON.stringify({ detail: "\u767B\u5165\u5DF2\u5931\u6548\uFF0C\u8ACB\u91CD\u65B0\u767B\u5165" }), { status: 401, headers: { "content-type": "application/json" } });
  }
}
__name(authenticate, "authenticate");
export async function requireAdmin(request, env) {
  const user = await authenticate(request, env);
  if (!user.admin) throw new Response(JSON.stringify({ detail: "\u9700\u8981\u7BA1\u7406\u54E1\u6B0A\u9650" }), { status: 403, headers: { "content-type": "application/json" } });
  return user;
}
__name(requireAdmin, "requireAdmin");
