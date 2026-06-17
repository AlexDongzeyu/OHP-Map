// Cloudflare Worker entry (doc 09 Part 2).
//
//   fetch()     — serves the static site and the dataset. /data/survivors.geojson is
//                 served from KV (the cache the cron keeps warm) and falls back to the
//                 committed file, so a page load never calls the external archive.
//   scheduled() — the daily Cron Trigger; refreshes the dataset from the OHP archive
//                 into KV, staging any NEW survivors as verified:false (pending review).
//
// "Auto-updating" here means auto-detected and auto-staged, never auto-published as
// fact: new entries arrive pending until a human verifies them (doc 09 Step 2.5).
import { syncSurvivors } from "./sync.js";

const DATA_KEY = "survivors.geojson";

export default {
  async scheduled(controller, env, ctx) {
    // No-op unless a KV namespace is bound (see wrangler.toml "Enabling auto-update").
    if (env.OHP_DATA) ctx.waitUntil(syncSurvivors(env));
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

    // Manual trigger for testing: GET /__sync runs the refresh now (needs KV).
    if (url.pathname === "/__sync") {
      if (!env.OHP_DATA) {
        return new Response("KV not configured; auto-update is disabled.\n", { status: 503 });
      }
      ctx.waitUntil(syncSurvivors(env));
      return new Response("sync started\n", { status: 202 });
    }

    return env.ASSETS.fetch(request);
  },
};
