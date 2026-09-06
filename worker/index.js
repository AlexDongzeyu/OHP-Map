// Full and compact archives are validated in the Durable Object, then streamed.
// Only the small routing catalog and an individual selected profile are parsed here.
import {
  DATA_KEY, PUBLIC_DATA_KEY, INDEX_KEY, CATALOG_KEY, SITEMAP_KEY, STATUS_KEY,
  isCurrentPublication,
} from "./sync.js";
import {
  DETAIL_PATTERN, INDEX_FORMAT, contentHash, profilePath, profileKey, seedCatalog, validCatalog,
} from "./publication.js";
import { renderProfileHtml, renderErrorHtml } from "./profile-pages.js";
import { matchesETag, secureResponse } from "./headers.js";
export { ArchiveSync } from "./archive-sync.js";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" };

async function queueRefresh(env, bootstrap = false) {
  if (!env.ARCHIVE_SYNC) throw new Error("Archive refresh is not configured");
  const runner = env.ARCHIVE_SYNC.get(env.ARCHIVE_SYNC.idFromName("archive"));
  const response = await runner.fetch(`https://archive-sync.internal/${bootstrap ? "bootstrap" : "run"}`, { method: "POST" });
  if (!response.ok) throw new Error(`Could not queue archive refresh: ${response.status}`);
}

function bootstrap(env, ctx) {
  if (env.ARCHIVE_SYNC && ctx?.waitUntil) {
    ctx.waitUntil(queueRefresh(env, true).catch((error) => console.warn(error.message)));
  }
}

function compactMetadata(metadata) {
  return isCurrentPublication(metadata) && metadata.index_format === INDEX_FORMAT;
}

function methodNotAllowed(allow = "GET, HEAD") {
  return new Response(`Use ${allow.replace(", ", " or ")}.\n`, {
    status: 405, headers: { allow, "cache-control": "no-store" },
  });
}

function errorResponse(status = 404, message, json = false) {
  return new Response(json ? JSON.stringify({
    error: message || "The requested public profile version was not found.",
    index_url: "/data/index.json",
    collection_url: "/#/explore",
  }) : renderErrorHtml(status, message), {
    status,
    headers: { "content-type": json ? JSON_HEADERS["content-type"] : "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function streamResponse(request, body, headers, status = 200) {
  const cached = status === 200 && matchesETag(request, headers.etag);
  if (cached || request.method === "HEAD") {
    await body?.cancel();
    return new Response(null, { status: cached ? 304 : status, headers });
  }
  return new Response(body, { status, headers });
}

async function asset(env, request, pathname) {
  const url = new URL(request.url);
  url.pathname = pathname;
  url.search = "";
  return env.ASSETS.fetch(new Request(url, request));
}

async function archiveResponse(request, env, ctx, pathname) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  const full = pathname === "/data/survivors.geojson";
  const keys = full ? [DATA_KEY, PUBLIC_DATA_KEY] : [pathname === "/sitemap.xml" ? SITEMAP_KEY : INDEX_KEY];
  if (env.OHP_DATA) {
    for (const key of keys) {
      const snapshot = await env.OHP_DATA.getWithMetadata(key, { type: "stream" });
      const valid = full ? isCurrentPublication(snapshot.metadata) : compactMetadata(snapshot.metadata);
      if (snapshot.value && valid) {
        if (key === PUBLIC_DATA_KEY) bootstrap(env, ctx);
        return streamResponse(request, snapshot.value, {
          "content-type": pathname === "/sitemap.xml" ? "application/xml; charset=utf-8" : JSON_HEADERS["content-type"],
          "cache-control": "public, max-age=300",
          "x-ohp-source": "kv",
          "x-ohp-publication": key === PUBLIC_DATA_KEY ? "validated-snapshot" : "live",
          etag: `"${snapshot.metadata.version}"`,
        });
      }
      await snapshot.value?.cancel();
    }
    console.warn("A validated live snapshot is not available; serving the bundled archive.");
    bootstrap(env, ctx);
  }
  const bundled = await asset(env, request, pathname);
  if (bundled.status !== 200 && bundled.status !== 304) {
    await bundled.body?.cancel();
    return errorResponse(503, "The archive snapshot is unavailable. Try again shortly.", pathname !== "/sitemap.xml");
  }
  const headers = new Headers(bundled.headers);
  headers.set("cache-control", "public, max-age=300");
  headers.set("x-ohp-source", "bundled");
  return new Response(bundled.body, { status: bundled.status, headers });
}

async function detailResponse(request, env, id, hash) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  const headers = {
    "content-type": JSON_HEADERS["content-type"],
    "cache-control": "public, max-age=31536000, immutable",
    etag: `"${hash}"`,
  };
  const bundled = await asset(env, request, profilePath(id, hash));
  if (bundled.status === 200 || bundled.status === 304) {
    return streamResponse(request, bundled.body, { ...headers, "x-ohp-source": "bundled" }, bundled.status);
  }
  await bundled.body?.cancel();
  if (bundled.status !== 404) return errorResponse(503, "The profile snapshot is unavailable. Try again shortly.", true);
  if (env.OHP_DATA) {
    const snapshot = await env.OHP_DATA.getWithMetadata(profileKey(id, hash), { type: "stream" });
    const metadata = snapshot.metadata;
    if (snapshot.value && metadata?.detail_format === INDEX_FORMAT && metadata.id === id && metadata.hash === hash) {
      return streamResponse(request, snapshot.value, { ...headers, "x-ohp-source": "kv" });
    }
    await snapshot.value?.cancel();
  }
  if (env.ARCHIVE_SYNC) {
    const runner = env.ARCHIVE_SYNC.get(env.ARCHIVE_SYNC.idFromName("archive"));
    const saved = await runner.fetch(`https://archive-sync.internal${profilePath(id, hash)}`);
    if (saved.ok && saved.headers.get("etag") === headers.etag) {
      return streamResponse(request, saved.body, { ...headers, "x-ohp-source": "durable" });
    }
    await saved.body?.cancel();
    if (saved.status !== 404) return errorResponse(503, "The profile snapshot is temporarily unavailable.", true);
  }
  return errorResponse(404, "This profile version is unavailable. Reload the collection to get its current version.", true);
}

async function currentCatalog(env, ctx) {
  if (env.OHP_DATA) {
    const snapshot = await env.OHP_DATA.getWithMetadata(CATALOG_KEY, { type: "json" });
    if (compactMetadata(snapshot.metadata) && validCatalog(snapshot.value) &&
      snapshot.value.version === snapshot.metadata.version) return snapshot.value;
    bootstrap(env, ctx);
  }
  const catalog = await seedCatalog(env);
  if (!catalog) throw new Error("The public profile catalog is unavailable");
  return catalog;
}

async function profileFeature(env, request, id, hash) {
  const snapshot = await detailResponse(new Request(request.url), env, id, hash);
  if (!snapshot.ok) {
    await snapshot.body?.cancel();
    throw new Error("The selected profile version is unavailable");
  }
  const feature = await snapshot.json();
  if (feature?.type !== "Feature" || feature.properties?.survivor_id !== id) throw new Error("Invalid profile snapshot");
  return feature;
}

async function profileResponse(request, env, ctx, match) {
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  const requested = match[1];
  const catalog = await currentCatalog(env, ctx);
  const id = Object.hasOwn(catalog.aliases, requested) ? catalog.aliases[requested] : requested;
  const hash = Object.hasOwn(catalog.profiles, id) ? catalog.profiles[id] : null;
  if (!hash) return errorResponse();
  const canonicalPath = `/survivor/${id}`;
  if (new URL(request.url).pathname !== canonicalPath) {
    return new Response(null, { status: 301, headers: { location: canonicalPath, "cache-control": "public, max-age=300" } });
  }
  const bundled = await asset(env, request, `/data/profile-pages/${id}.${hash}.html`);
  if (bundled.status === 200 || bundled.status === 304) {
    const headers = new Headers(bundled.headers);
    headers.set("cache-control", "public, max-age=0, must-revalidate");
    return new Response(bundled.body, { status: bundled.status, headers });
  }
  await bundled.body?.cancel();
  if (bundled.status !== 404) throw new Error("Profile HTML is unavailable");
  const feature = await profileFeature(env, request, id, hash);
  let sourceText = feature.properties.source_biography;
  if (sourceText === undefined) {
    const biography = await asset(env, new Request(request.url), `/data/biographies/${id}.json`);
    if (biography.ok) {
      const source = await biography.json();
      if (source.source_url === feature.properties.archive_url && typeof source.text === "string") sourceText = source.text;
    } else await biography.body?.cancel();
  }
  const shell = await asset(env, new Request(request.url), "/index.html");
  if (!shell.ok) {
    await shell.body?.cancel();
    throw new Error("The application shell is unavailable");
  }
  const body = renderProfileHtml(await shell.text(), feature, { origin: env.SITE_ORIGIN, sourceText });
  // The profile hash alone is not an HTML content hash: the shell and original
  // biography can also change. Live HTML must revalidate, not claim immutability.
  return streamResponse(request, new Response(body).body, {
    "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate",
    etag: `"${await contentHash(body)}"`,
  });
}

async function route(request, env, ctx) {
  const url = new URL(request.url);
  if (["/data/survivors.geojson", "/data/index.json", "/sitemap.xml"].includes(url.pathname)) {
    return archiveResponse(request, env, ctx, url.pathname);
  }
  const detail = url.pathname.match(DETAIL_PATTERN);
  if (detail) return detailResponse(request, env, detail[1], detail[2]);
  if (url.pathname.startsWith("/data/profiles/")) return errorResponse(404, undefined, true);
  const profile = url.pathname.match(/^\/survivor\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
  if (profile) return profileResponse(request, env, ctx, profile);
  if (url.pathname === "/survivor" || url.pathname.startsWith("/survivor/")) return errorResponse();

  if (url.pathname === "/__sync/status") {
    if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
    if (!env.OHP_DATA) return new Response(JSON.stringify({ state: "unconfigured" }), { status: 503, headers: JSON_HEADERS });
    const status = await env.OHP_DATA.get(STATUS_KEY);
    return new Response(status || JSON.stringify({ state: "waiting-for-first-sync" }), {
      status: status ? 200 : 202, headers: JSON_HEADERS,
    });
  }
  if (url.pathname === "/__sync") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!env.SYNC_TOKEN || !env.ARCHIVE_SYNC) {
      return new Response("Manual sync is disabled; the hourly schedule remains active when configured.\n", { status: 503 });
    }
    if (request.headers.get("authorization") !== `Bearer ${env.SYNC_TOKEN}`) {
      return new Response("Unauthorized.\n", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    await queueRefresh(env);
    return new Response("sync queued\n", { status: 202, headers: { "cache-control": "no-store" } });
  }
  if (!["GET", "HEAD"].includes(request.method)) return methodNotAllowed();
  // Internal build resources have canonical public routes above, not duplicate
  // crawlable HTML routes. Unknown paths never receive the SPA's 200 shell.
  if (url.pathname.startsWith("/data/profile-pages/") || url.pathname.startsWith("/data/biographies/") ||
    url.pathname === "/data/catalog.json") return errorResponse();
  const response = await asset(env, request, url.pathname === "/" ? "/index.html" : url.pathname);
  if (response.status === 404) {
    await response.body?.cancel();
    return errorResponse();
  }
  return response;
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(queueRefresh(env));
  },
  async fetch(request, env, ctx) {
    let response;
    try {
      response = await route(request, env, ctx);
    } catch (error) {
      console.warn(`Archive request failed: ${error.message}`);
      response = errorResponse(503, "The archive is temporarily unavailable. Try again shortly, or visit the original OHP archive.",
        new URL(request.url).pathname.startsWith("/data/"));
    }
    return secureResponse(response, request);
  },
};
