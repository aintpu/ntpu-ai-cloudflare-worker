const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const nowIso = () => new Date().toISOString();
export const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
});
export const error = (detail, status = 400) => json({ detail }, status);
export const randomHex = (bytes = 16) => [...crypto.getRandomValues(new Uint8Array(bytes))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
export const base64url = (bytes) => btoa(String.fromCharCode(...bytes))
  .replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
export const fromBase64url = (text) => Uint8Array.from(atob(text.replace(/-/g, "+").replace(/_/g, "/")), c => c.charCodeAt(0));
export async function sha256(text) {
  return base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}
export function safeJson(text, fallback = null) { try { return JSON.parse(text); } catch { return fallback; } }
export function uidFromEmail(email) { return `u_${email.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 80)}`; }
export function sse(data) { return `data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`; }
export function securityHeaders(response, edge = true) {
  const headers = new Headers(response.headers);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  headers.set("X-Frame-Options", "DENY");
  if (edge) headers.set("X-NTPU-Edge", "cloudflare-native");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
export async function aesEncrypt(value, secret, aad = "") {
  if (!secret) return "";
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, encoder.encode(value));
  return `${base64url(iv)}.${base64url(new Uint8Array(encrypted))}`;
}
export async function aesDecrypt(value, secret, aad = "") {
  const [ivText, cipherText] = String(value).split(".");
  const keyBytes = await crypto.subtle.digest("SHA-256", encoder.encode(secret));
  const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["decrypt"]);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(ivText), additionalData: encoder.encode(aad) }, key, fromBase64url(cipherText));
  return decoder.decode(plain);
}
