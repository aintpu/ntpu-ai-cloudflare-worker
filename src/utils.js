export function __name(target, value) {
  return Object.defineProperty(target, "name", { value, configurable: true });
}

var encoder = new TextEncoder();
var decoder = new TextDecoder();
export var nowIso = /* @__PURE__ */ __name(() => (/* @__PURE__ */ new Date()).toISOString(), "nowIso");
export var json = /* @__PURE__ */ __name((data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers }
}), "json");
export var error = /* @__PURE__ */ __name((detail, status = 400) => json({ detail }, status), "error");
export var randomHex = /* @__PURE__ */ __name((bytes = 16) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b3) => b3.toString(16).padStart(2, "0")).join(""), "randomHex");
export var base64url = /* @__PURE__ */ __name((bytes) => btoa(String.fromCharCode(...bytes)).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"), "base64url");
export var fromBase64url = /* @__PURE__ */ __name((text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0)), "fromBase64url");
export function cookieValue(request, name) {
  const prefix = `${name}=`;
  for (const part of String(request.headers.get("cookie") || "").split(";")) {
    const item = part.trim();
    if (item.startsWith(prefix)) return decodeURIComponent(item.slice(prefix.length));
  }
  return "";
}
__name(cookieValue, "cookieValue");
export function safeJson(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}
__name(safeJson, "safeJson");
export function uidFromEmail(email) {
  const normalized = String(email || "").trim().toLowerCase();
  return `u_${base64url(encoder.encode(normalized))}`;
}
__name(uidFromEmail, "uidFromEmail");
export function sse(data) {
  return `data: ${typeof data === "string" ? data : JSON.stringify(data)}

`;
}
__name(sse, "sse");
function sameOriginRequest(request) {
  const requestOrigin = new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (origin) return origin === requestOrigin;
  const referer = request.headers.get("referer");
  if (!referer) return false;
  try {
    return new URL(referer).origin === requestOrigin;
  } catch {
    return false;
  }
}
__name(sameOriginRequest, "sameOriginRequest");
export var requireSameOrigin = /* @__PURE__ */ __name((request) => sameOriginRequest(request) ? null : error("\u62D2\u7D55\u8DE8\u4F86\u6E90\u72C0\u614B\u8B8A\u66F4", 403), "requireSameOrigin");
function cspNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}
__name(cspNonce, "cspNonce");
export async function securityHeaders(response, edge = true) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Content-Security-Policy", [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "form-action 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data: https:",
    "connect-src 'self' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    "frame-src 'self' blob: https://challenges.cloudflare.com",
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'"
  ].join("; "));
  if (edge) headers.set("X-NTPU-Edge", "cloudflare-native");
  const contentType = headers.get("content-type") || "";
  if (contentType.toLowerCase().includes("text/html")) {
    const nonce = cspNonce();
    headers.set("Content-Security-Policy", [
      "default-src 'self'",
      `script-src 'self' 'nonce-${nonce}' https://cdn.jsdelivr.net https://challenges.cloudflare.com`,
      "script-src-attr 'none'",
      `style-src 'self' 'nonce-${nonce}'`,
      "style-src-attr 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "connect-src 'self' https://challenges.cloudflare.com",
      "media-src 'self' blob:",
      "frame-src 'self' blob: https://challenges.cloudflare.com",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'"
    ].join("; "));
    headers.delete("content-length");
    headers.delete("content-encoding");
    const html = await response.text();
    return new Response(html.replaceAll("__CSP_NONCE__", nonce), {
      status: response.status,
      statusText: response.statusText,
      headers
    });
  }
  headers.set("Content-Security-Policy", "default-src 'self'; frame-ancestors 'none'");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
__name(securityHeaders, "securityHeaders");
export async function aesDecrypt(value, secret, aad = "") {
  const [ivText, cipherText] = String(value).split(".");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(ivText), additionalData: encoder.encode(aad) }, key, fromBase64url(cipherText));
  return decoder.decode(plain);
}
__name(aesDecrypt, "aesDecrypt");
