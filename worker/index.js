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
import { DATA_KEY, STATUS_KEY, syncSurvivors } from "./sync.js";

const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncSurvivors(env));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // Serve the dataset from the warm KV cache when one is configured and populated.
    if (url.pathname === "/data/survivors.geojson" && env.OHP_DATA) {
      const cached = await env.OHP_DATA.get(DATA_KEY);
      if (cached) {
        return new Response(cached, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "public, max-age=300",
            "x-ohp-source": "kv",
          },
        });
      }
      // Cold cache → fall through to the committed file via ASSETS.
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
      ctx.waitUntil(syncSurvivors(env));
      return new Response("sync started\n", { status: 202 });
    }

    return env.ASSETS.fetch(request);
  },
};
