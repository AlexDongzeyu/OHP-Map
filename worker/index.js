// Cloudflare Worker entry (doc 09 Part 2).
//
//   fetch()     — serves the static site and the dataset. /data/survivors.geojson is
//                 served from KV (the cache the cron keeps warm) and falls back to the
//                 committed file, so a page load never calls the external archive.
//   scheduled() — hourly discovery across the full OHP taxonomy plus a bounded rotating
//                 profile refresh, written to Workers KV.
//
// "Auto-updating" here means auto-detected and auto-staged, never auto-published as
// fact: new entries arrive pending until a human verifies them (doc 09 Step 2.5).
import {
  DATA_KEY,
  PUBLIC_DATA_KEY,
  STATUS_KEY,
  isCurrentPublication,
} from "./sync.js";
export { ArchiveSync } from "./archive-sync.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

async function queueRefresh(env, bootstrap = false) {
  const runner = env.ARCHIVE_SYNC.get(env.ARCHIVE_SYNC.idFromName("archive"));
  const response = await runner.fetch(`https://archive-sync.internal/${bootstrap ? "bootstrap" : "run"}`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not queue archive refresh: ${response.status}`);
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(queueRefresh(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Validation and migration happen when publishing, not while serving the large body.
    if (url.pathname === "/data/survivors.geojson" && env.OHP_DATA) {
      if (!["GET", "HEAD"].includes(request.method)) {
        return new Response("Use GET or HEAD.\n", { status: 405, headers: { allow: "GET, HEAD" } });
      }
      for (const key of [DATA_KEY, PUBLIC_DATA_KEY]) {
        const snapshot = await env.OHP_DATA.getWithMetadata(key, { type: "stream" });
        if (snapshot.value && isCurrentPublication(snapshot.metadata)) {
          if (key === PUBLIC_DATA_KEY && env.ARCHIVE_SYNC) ctx.waitUntil(queueRefresh(env, true));
          const etag = `"${snapshot.metadata.version}"`;
          const headers = {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-ohp-source": "kv",
            "x-ohp-publication": key === DATA_KEY ? "live" : "validated-snapshot",
            etag,
          };
          const cached = request.headers.get("if-none-match")?.split(",").some((value) =>
            value.trim() === etag || value.trim() === `W/${etag}` || value.trim() === "*");
          if (cached || request.method === "HEAD") {
            await snapshot.value.cancel();
            return new Response(null, { status: cached ? 304 : 200, headers });
          }
          return new Response(snapshot.value, { headers });
        }
        if (snapshot.value) await snapshot.value.cancel();
      }
      console.warn("A validated live snapshot is not available; serving the bundled archive.");
      if (env.ARCHIVE_SYNC) ctx.waitUntil(queueRefresh(env, true));
      const bundled = await env.ASSETS.fetch(request);
      const headers = new Headers(bundled.headers);
      headers.set("x-ohp-source", "bundled");
      return new Response(bundled.body, { status: bundled.status, statusText: bundled.statusText, headers });
    }

    if (url.pathname === "/__sync/status") {
      const status = await env.OHP_DATA.get(STATUS_KEY);
      return new Response(status || JSON.stringify({ state: "waiting-for-first-sync" }), {
        status: status ? 200 : 202,
        headers: JSON_HEADERS,
      });
    }

    // Manual refreshes are disabled unless a secret is explicitly configured.
    if (url.pathname === "/__sync") {
      if (request.method !== "POST") {
        return new Response("Use POST.\n", { status: 405, headers: { allow: "POST" } });
      }
      if (!env.SYNC_TOKEN) {
        return new Response("Manual sync is disabled; the hourly schedule remains active.\n", { status: 503 });
      }
      if (request.headers.get("authorization") !== `Bearer ${env.SYNC_TOKEN}`) {
        return new Response("Unauthorized.\n", { status: 401 });
      }
      ctx.waitUntil(queueRefresh(env));
      return new Response("sync started\n", { status: 202 });
    }

    return env.ASSETS.fetch(request);
  },
};
