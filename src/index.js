const DEFAULT_BACKEND_ORIGIN = "https://ntpu-router-495790502594.asia-east1.run.app";

const API_EXACT_PATHS = new Set([
  "/health",
  "/models",
  "/reset",
  "/conversations",
  "/me",
  "/upload",
  "/file-preview",
  "/transcribe",
]);

const API_PATH_PREFIXES = [
  "/chat/",
  "/feedback/",
  "/conversations/",
  "/share/",
  "/user/",
  "/admin/",
];

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(self), geolocation=()",
  "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://www.gstatic.com https://apis.google.com",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' data: blob:",
    "connect-src 'self' https://*.googleapis.com https://*.firebaseapp.com https://www.gstatic.com",
    "frame-src https://*.firebaseapp.com https://accounts.google.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "),
};

export function isApiPath(pathname) {
  return API_EXACT_PATHS.has(pathname)
    || API_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function backendOrigin(env) {
  const candidate = env.BACKEND_ORIGIN || DEFAULT_BACKEND_ORIGIN;
  const parsed = new URL(candidate);
  if (parsed.protocol !== "https:") {
    throw new Error("BACKEND_ORIGIN must use HTTPS");
  }
  return parsed.origin;
}

function sanitizedProxyHeaders(request, publicUrl) {
  const headers = new Headers(request.headers);
  // 不把 Cloudflare 的訪客網路識別標頭主動轉送到應用程式層。
  headers.delete("cf-connecting-ip");
  headers.delete("cf-ipcountry");
  headers.delete("cf-ray");
  headers.delete("cf-visitor");
  headers.set("X-Forwarded-Host", publicUrl.host);
  headers.set("X-Forwarded-Proto", "https");
  return headers;
}

async function proxyToBackend(request, env, fetchImpl) {
  const publicUrl = new URL(request.url);
  const target = new URL(publicUrl.pathname + publicUrl.search, backendOrigin(env));
  const init = {
    method: request.method,
    headers: sanitizedProxyHeaders(request, publicUrl),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
    // Node 的 Fetch 實作要求串流 request body 明示 duplex；workerd 會安全接受此欄位。
    init.duplex = "half";
  }

  try {
    const upstream = await fetchImpl(new Request(target, init));
    const headers = new Headers(upstream.headers);
    headers.set("X-NTPU-Edge", "cloudflare-worker");
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers,
    });
  } catch {
    return Response.json(
      { detail: "後端服務目前無法連線，請稍後再試" },
      { status: 502, headers: { "Cache-Control": "no-store" } },
    );
  }
}

function addSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  headers.set("X-NTPU-Edge", "cloudflare-worker");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function handleRequest(request, env, fetchImpl = fetch) {
  const url = new URL(request.url);
  if (isApiPath(url.pathname)) {
    return proxyToBackend(request, env, fetchImpl);
  }
  return addSecurityHeaders(await env.ASSETS.fetch(request));
}

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
};
