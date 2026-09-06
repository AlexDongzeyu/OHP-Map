import { DETAIL_PATTERN } from "./publication.js";
import { isReleaseAssetPath, isStaticAliasPath } from "./static-assets.js";

export const SECURITY_HEADERS = {
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://ohp.crestwood.on.ca https://crestwood.on.ca https://www.crestwood.on.ca",
    "font-src 'self'",
    "connect-src 'self'",
    "frame-src 'self' https://player.vimeo.com https://ohpmap.alexdong0414.workers.dev",
    "media-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'self' https://crestwood.on.ca https://www.crestwood.on.ca https://*.crestwood.on.ca",
  ].join("; "),
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), accelerometer=(), gyroscope=(), magnetometer=(), autoplay=(self "https://player.vimeo.com"), fullscreen=(self "https://player.vimeo.com")',
};

export function matchesETag(request, etag) {
  return request.headers.get("if-none-match")?.split(",").some((value) =>
    value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === "*");
}

export async function secureResponse(response, request) {
  const headers = new Headers(response.headers);
  const url = new URL(request.url);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
  headers.delete("x-frame-options");
  if (url.protocol === "https:") headers.set("strict-transport-security", "max-age=31536000");
  if (response.status >= 400) {
    headers.set("cache-control", "no-store");
  } else if (isReleaseAssetPath(url.pathname) && [200, 206, 304].includes(response.status) && ["GET", "HEAD"].includes(request.method)) {
    headers.set("cache-control", "public, max-age=31536000, immutable");
  } else if (isStaticAliasPath(url.pathname)) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  } else if (!headers.has("cache-control")) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  } else if (!DETAIL_PATTERN.test(url.pathname) && /\bimmutable\b/i.test(headers.get("cache-control"))) {
    headers.set("cache-control", "public, max-age=0, must-revalidate");
  }
  if (request.method === "HEAD") await response.body?.cancel();
  return new Response(request.method === "HEAD" ? null : response.body, {
    status: response.status, statusText: response.statusText, headers,
  });
}
