// Hourly archive refresh: check every OHP category for additions, then refresh a bounded
// rotating batch of existing profiles. New data is auto-extracted and remains unverified.
import gazetteer from "../data/gazetteer.json";
import geocodeCache from "../data/geocode_cache.json";
import otherMediaPages from "../data/source/ohp_media_pages.json";
import {
  decodeEntities,
  mergeMediaCoverage,
  mergeSeedMediaCoverage,
  parseProfileMedia,
  sourceBiography,
  sourceInventory,
  videoInventory,
} from "./media.js";

const BASE = "https://ohp.crestwood.on.ca";
const UA = "CrestwoodOHP-Map-Worker/2.0 (+https://github.com/AlexDongzeyu/OHP-Map)";
export const DATA_KEY = "survivors.geojson";
export const STATUS_KEY = "ohp-sync-status.json";
export const GAZETTEER_REVISION = gazetteer.revision;
export const CONTENT_REVISION = "reconciled-public-sources-v5";
export const HISTORY_MIN_YEAR = 1914;
export const HISTORY_MAX_YEAR = 2026;
const SEEN_KEY = "ohp-seen-slugs.json";
const FAILURE_KEY = "ohp-fetch-failures.json";
const CURSOR_KEY = "ohp-refresh-cursor";
const DETAIL_BUDGET = 30;
const RUN_LOCK_MINUTES = 15;

const CATEGORIES = [
  ["holocaust-survivors", "Holocaust Survivors"],
  ["military-veterans-al", "Military Veterans"],
  ["military-veterans-mz", "Military Veterans"],
  ["community-members", "Community Members"],
  ["first-nations", "First Nations"],
  ["crestwood-families", "Crestwood Families"],
];
const GROUP_ORDER = [
  "Holocaust Survivors",
  "Military Veterans",
  "Community Members",
  "First Nations",
  "Crestwood Families",
];
const RESETTLEMENT = new Set([
  "Toronto, Canada", "Canada", "Montreal, Canada", "Israel",
  "New York, USA", "Vienna, Austria",
]);
const ROLE_ORDER = { birthplace: 0, ghetto: 1, camp: 2, transit: 3, liberation: 4, resettlement: 5 };
const NON_PROFILE_SLUGS = new Set(otherMediaPages.pages.map((page) => page.survivor_id));

export async function syncSurvivors(env) {
  if (!env.OHP_DATA || !env.ASSETS) throw new Error("OHP_DATA and ASSETS bindings are required");
  const startedAt = new Date().toISOString();
  const previousStatus = await env.OHP_DATA.get(STATUS_KEY, "json");
  if (
    previousStatus?.state === "running" &&
    Date.now() - Date.parse(previousStatus.started_at) < RUN_LOCK_MINUTES * 60 * 1000
  ) {
    return { state: "already-running", started_at: previousStatus.started_at };
  }
  await env.OHP_DATA.put(STATUS_KEY, JSON.stringify({ state: "running", started_at: startedAt }));

  try {
    const current = await loadCurrentData(env);
    const featuresById = new Map(
      (current.features || []).map((feature) => [feature.properties.survivor_id, feature]),
    );
    const seenDoc = await env.OHP_DATA.get(SEEN_KEY, "json");
    const seen = new Set([...(Array.isArray(seenDoc) ? seenDoc : []), ...featuresById.keys()]);
    const failures = (await env.OHP_DATA.get(FAILURE_KEY, "json")) || {};
    const aliases = new Map(current.features.flatMap((feature) => (
      (feature.properties.source_aliases || []).map((alias) => [alias, feature.properties.survivor_id])
    )));
    const listed = [...new Map((await listArchiveEntries()).map((entry) => {
      const slug = aliases.get(entry.slug) || entry.slug;
      return [slug, { ...entry, slug }];
    })).values()];
    const newlyListed = listed.filter((entry) => !seen.has(entry.slug));
    const retryEligible = (entry) => (
      !failures[entry.slug] ||
      Date.parse(failures[entry.slug].retry_after) <= Date.now()
    );
    const eligibleNew = newlyListed.filter(retryEligible);
    const newBatch = eligibleNew.slice(0, DETAIL_BUDGET);

    const refreshable = listed.filter((entry) => (
      seen.has(entry.slug) &&
      featuresById.get(entry.slug)?.properties?.review_status !== "reviewed"
    ));
    const eligibleRefresh = refreshable.filter(retryEligible);
    const cursor = Number(await env.OHP_DATA.get(CURSOR_KEY)) || 0;
    const refreshSlots = Math.max(0, DETAIL_BUDGET - newBatch.length);
    const refreshBatch = circularSlice(eligibleRefresh, cursor, refreshSlots);
    const batch = [...newBatch, ...refreshBatch];

    let added = 0;
    let updated = 0;
    let unplaced = 0;
    let failed = 0;

    for (const entry of batch) {
      const html = await fetchText(`${BASE}/ohp/${entry.slug}/`);
      if (!html) {
        failures[entry.slug] = nextFailure(failures[entry.slug]);
        failed++;
        continue;
      }
      const record = parseEntry(entry.slug, html, entry.group);
      if (record.protected) {
        delete failures[entry.slug];
        seen.add(entry.slug);
        featuresById.delete(entry.slug);
        continue;
      }
      if (!record.source_public) {
        failures[entry.slug] = nextFailure(failures[entry.slug]);
        failed++;
        continue;
      }
      delete failures[entry.slug];
      seen.add(entry.slug);
      const fresh = toFeature(record);
      if (!fresh.geometry) unplaced++;

      const existing = featuresById.get(entry.slug);
      if (!existing) {
        featuresById.set(entry.slug, fresh);
        added++;
        continue;
      }
      const merged = mergeFeature(existing, fresh);
      if (JSON.stringify(merged) !== JSON.stringify(existing)) {
        featuresById.set(entry.slug, merged);
        updated++;
      }
    }

    const features = [...featuresById.values()];
    const nextCursor = eligibleRefresh.length
      ? (cursor + refreshBatch.length) % eligibleRefresh.length
      : 0;
    const completedAt = new Date().toISOString();
    const groups = countGroups(features);
    const doc = {
      type: "FeatureCollection",
      metadata: {
        ...(current.metadata || {}),
        generator: "worker/sync.js",
        source: "cloudflare-live-sync",
        gazetteer_revision: GAZETTEER_REVISION,
        content_revision: CONTENT_REVISION,
        time_min: HISTORY_MIN_YEAR,
        time_max: HISTORY_MAX_YEAR,
        count: features.length,
        groups,
        group_order: GROUP_ORDER,
        reviewed: features.filter((feature) => feature.properties.review_status === "reviewed").length,
        pending: features.filter((feature) => feature.properties.review_status !== "reviewed").length,
        placed: features.filter((feature) => feature.properties.waypoints.length).length,
        unplaced: features.filter((feature) => !feature.properties.waypoints.length).length,
        sample_data: false,
        refreshed_at: completedAt,
        notice:
          "Place names and dates were matched automatically from public OHP pages " +
          "and may need correction. The OHP page remains the source.",
      },
      features,
    };
    const status = {
      state: "ready",
      started_at: startedAt,
      completed_at: completedAt,
      categories_checked: CATEGORIES.length,
      profiles_listed: listed.length,
      profiles_checked: batch.length,
      newly_listed: newlyListed.length,
      deferred_failures: newlyListed.length - eligibleNew.length + refreshable.length - eligibleRefresh.length,
      added,
      updated,
      unplaced,
      failed,
      total: features.length,
      groups,
      gazetteer_revision: GAZETTEER_REVISION,
      content_revision: CONTENT_REVISION,
      next_cursor: nextCursor,
    };

    await Promise.all([
      env.OHP_DATA.put(DATA_KEY, JSON.stringify(doc)),
      env.OHP_DATA.put(SEEN_KEY, JSON.stringify([...seen].sort())),
      env.OHP_DATA.put(FAILURE_KEY, JSON.stringify(failures)),
      env.OHP_DATA.put(CURSOR_KEY, String(nextCursor)),
      env.OHP_DATA.put(STATUS_KEY, JSON.stringify(status)),
    ]);
    return status;
  } catch (error) {
    const status = {
      state: "error",
      started_at: startedAt,
      failed_at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    };
    await env.OHP_DATA.put(STATUS_KEY, JSON.stringify(status));
    throw error;
  }
}

async function loadCurrentData(env) {
  const cached = await env.OHP_DATA.get(DATA_KEY, "json");
  const seed = await loadSeedData(env);
  if (!cached?.features) return seed;
  if (
    cached.metadata?.gazetteer_revision !== GAZETTEER_REVISION ||
    cached.metadata?.content_revision !== CONTENT_REVISION
  ) {
    return migrateCachedData(cached, seed);
  }
  return mergeSeedPortraits(cached, seed);
}

async function loadSeedData(env) {
  const response = await env.ASSETS.fetch(new Request("https://assets.local/data/survivors.geojson"));
  if (!response.ok) throw new Error(`Unable to load the committed dataset: ${response.status}`);
  const seed = await response.json();
  if (!seed?.features) throw new Error("Committed dataset is not a FeatureCollection");
  return seed;
}

function mergeSeedPortraits(cached, seed) {
  const seedById = new Map(
    seed.features.map((feature) => [feature.properties.survivor_id, feature.properties]),
  );
  return {
    ...cached,
    features: cached.features.map((feature) => {
      const seeded = seedById.get(feature.properties.survivor_id);
      if (!seeded) return feature;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          portrait: feature.properties.portrait || seeded.portrait || null,
          portrait_rights: feature.properties.portrait_rights || seeded.portrait_rights || null,
          portrait_faces: feature.properties.portrait_faces || seeded.portrait_faces || 0,
          ...mergeSeedMediaCoverage(feature.properties, seeded),
        },
      };
    }),
  };
}

export async function ensureCurrentData(env, cached) {
  let current = cached;
  if (
    cached.metadata?.gazetteer_revision !== GAZETTEER_REVISION ||
    cached.metadata?.content_revision !== CONTENT_REVISION
  ) {
    const seed = await loadSeedData(env);
    current = migrateCachedData(cached, seed);
  }
  if (
    current.metadata?.time_min !== HISTORY_MIN_YEAR ||
    current.metadata?.time_max !== HISTORY_MAX_YEAR
  ) {
    current = {
      ...current,
      metadata: {
        ...(current.metadata || {}),
        content_revision: CONTENT_REVISION,
        time_min: HISTORY_MIN_YEAR,
        time_max: HISTORY_MAX_YEAR,
      },
    };
  }
  if (current !== cached) await env.OHP_DATA.put(DATA_KEY, JSON.stringify(current));
  return current;
}

function migrateCachedData(cached, seed) {
  const geographyChanged = cached.metadata?.gazetteer_revision !== GAZETTEER_REVISION;
  const cachedById = new Map(
    cached.features.map((feature) => [feature.properties.survivor_id, feature]),
  );
  const seedIds = new Set();
  const features = seed.features.map((seedFeature) => {
    const id = seedFeature.properties.survivor_id;
    seedIds.add(id);
    const aliases = seedFeature.properties.source_aliases || [];
    for (const alias of aliases) seedIds.add(alias);
    const candidates = [
      ...aliases.map((alias) => cachedById.get(alias)), cachedById.get(id),
    ].filter(Boolean);
    const existing = candidates.find((feature) => (
      feature.properties.review_status === "reviewed" ||
      feature.properties.waypoints.some((waypoint) => waypoint.verified)
    )) || candidates[0];
    if (!existing) return seedFeature;
    const identity = {
      survivor_id: id,
      archive_url: seedFeature.properties.archive_url || existing.properties.archive_url,
      ...(aliases.length ? { source_aliases: aliases } : {}),
    };
    if (existing.properties.review_status === "reviewed") {
      return {
        ...existing,
        properties: {
          ...existing.properties,
          ...identity,
          ...mergeSeedMediaCoverage(existing.properties, seedFeature.properties),
        },
      };
    }
    const hasReviewedPlaces = existing.properties.waypoints.some((waypoint) => waypoint.verified);
    const replaceGeography = geographyChanged && !hasReviewedPlaces;
    const waypoints = replaceGeography
      ? seedFeature.properties.waypoints
      : mergeSeedQuotes(existing.properties.waypoints, seedFeature.properties.waypoints);
    return {
      ...existing,
      geometry: replaceGeography ? seedFeature.geometry : existing.geometry,
      properties: {
        ...seedFeature.properties,
        ...existing.properties,
        ...identity,
        bio_excerpt: sentenceExcerpt(
          seedFeature.properties.bio_excerpt || existing.properties.bio_excerpt || "",
        ),
        ...mergeSeedMediaCoverage(existing.properties, seedFeature.properties),
        featured: seedFeature.properties.featured || existing.properties.featured || false,
        media_url: existing.properties.media_url || seedFeature.properties.media_url || null,
        portrait: existing.properties.portrait || seedFeature.properties.portrait || null,
        portrait_rights:
          existing.properties.portrait_rights || seedFeature.properties.portrait_rights || null,
        portrait_faces:
          seedFeature.properties.portrait_faces || existing.properties.portrait_faces || 0,
        theme_tags: seedFeature.properties.theme_tags?.length
          ? seedFeature.properties.theme_tags
          : (existing.properties.theme_tags || []),
        waypoints,
      },
    };
  });

  for (const feature of cached.features) {
    if (seedIds.has(feature.properties.survivor_id) || NON_PROFILE_SLUGS.has(feature.properties.survivor_id)) continue;
    if (feature.properties.review_status === "reviewed") {
      features.push(feature);
      continue;
    }
    const sanitized = geographyChanged
      ? sanitizeCachedFeature(feature)
      : {
        ...feature,
        properties: {
          ...feature.properties,
          waypoints: feature.properties.waypoints.map((waypoint) => (
            repairSourceQuote(waypoint, feature.properties.bio_excerpt || "")
          )),
        },
      };
    if (sanitized) features.push(sanitized);
  }

  const reviewed = features.filter(
    (feature) => feature.properties.review_status === "reviewed",
  ).length;
  return {
    ...cached,
    metadata: {
      ...(cached.metadata || {}),
      ...(seed.metadata?.archive_coverage ? { archive_coverage: seed.metadata.archive_coverage } : {}),
      count: features.length,
      groups: countGroups(features),
      reviewed,
      pending: features.length - reviewed,
      placed: features.filter((feature) => feature.properties.waypoints.length).length,
      unplaced: features.filter((feature) => !feature.properties.waypoints.length).length,
      gazetteer_revision: GAZETTEER_REVISION,
      content_revision: CONTENT_REVISION,
      time_min: HISTORY_MIN_YEAR,
      time_max: HISTORY_MAX_YEAR,
      migrated_at: new Date().toISOString(),
    },
    features,
  };
}

function mergeSeedQuotes(existing, seeded) {
  return existing.map((waypoint) => {
    if (waypoint.verified) return waypoint;
    const source = seeded.find((candidate) => (
      candidate.canonical === waypoint.canonical && candidate.as_written === waypoint.as_written
    ));
    return source?.source_quote
      ? { ...waypoint, source_quote: source.source_quote }
      : waypoint;
  });
}

function sanitizeCachedFeature(feature) {
  if (feature.properties.waypoints.some((waypoint) => waypoint.verified)) return feature;
  const seen = new Set();
  const waypoints = [];
  const cachedWaypoints = feature.properties.waypoints || [];
  for (const waypoint of cachedWaypoints) {
    const key = aliasKey(waypoint.as_written);
    const canonical = gazetteer.aliases[key];
    const coordinates = geocodeCache[canonical];
    if (!canonical || !coordinates || seen.has(canonical)) continue;
    if (isQualifiedCountryWaypoint(waypoint, canonical, cachedWaypoints)) continue;
    seen.add(canonical);
    waypoints.push({
      ...waypoint,
      canonical,
      role: gazetteer.known_sites[canonical] || waypoint.role,
      lat: round(coordinates.lat),
      lng: round(coordinates.lng),
    });
  }
  const retainedBirthplace = waypoints.find((waypoint) => (
    !gazetteer.known_sites[waypoint.canonical] && waypoint.role === "birthplace"
  ));
  const inferredBirthplace = waypoints.find((waypoint) => (
    !gazetteer.known_sites[waypoint.canonical] && !RESETTLEMENT.has(waypoint.canonical)
  ));
  const birthplace = retainedBirthplace || inferredBirthplace;
  const rerolled = waypoints.map((waypoint) => {
    const siteRole = gazetteer.known_sites[waypoint.canonical];
    let role = waypoint.role;
    if (siteRole) role = siteRole;
    else if (waypoint === birthplace) role = "birthplace";
    else if (RESETTLEMENT.has(waypoint.canonical)) role = "resettlement";
    else if (role === "birthplace") role = "transit";
    return { ...waypoint, role };
  });
  const ordered = orderWaypoints(rerolled);
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  return {
    ...feature,
    geometry: home ? { type: "Point", coordinates: [home.lng, home.lat] } : null,
    properties: {
      ...feature.properties,
      bio_excerpt: sentenceExcerpt(feature.properties.bio_excerpt || ""),
      waypoints: ordered,
    },
  };
}

function aliasKey(value) {
  return String(value || "")
    .trim().toLowerCase().replace(/\s+/g, " ").replace(/^[\s.,;:]+|[\s.,;:]+$/g, "");
}

function isQualifiedCountryWaypoint(waypoint, canonical, candidates) {
  if (canonical.includes(",")) return false;
  const quote = waypoint.source_quote || "";
  const countryMatches = [
    ...quote.matchAll(new RegExp(`\\b${escapePattern(waypoint.as_written)}\\b`, "gi")),
  ];
  if (!countryMatches.length) return false;
  return countryMatches.every((match) => candidates.some((candidate) => {
    const cityCanonical = gazetteer.aliases[aliasKey(candidate.as_written)];
    if (!cityCanonical?.includes(",")) return false;
    const city = escapePattern(candidate.as_written);
    return new RegExp(`\\b${city}\\s*,\\s*$`, "i").test(quote.slice(0, match.index));
  }));
}

function escapePattern(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function listArchiveEntries() {
  const pages = await Promise.all(CATEGORIES.map(async ([term, group]) => {
    const html = await fetchText(`${BASE}/ohp-type/${term}/`);
    if (!html) throw new Error(`Unable to load OHP category: ${term}`);
    return extractSlugs(html).map((slug) => ({ slug, group }));
  }));
  const unique = new Map();
  for (const entries of pages) {
    for (const entry of entries) if (!unique.has(entry.slug)) unique.set(entry.slug, entry);
  }
  return [...unique.values()].sort((a, b) => a.slug.localeCompare(b.slug));
}

async function fetchText(url) {
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch(url, {
        headers: { "User-Agent": UA },
        redirect: "follow",
      });
      if (response.ok) return await response.text();
      lastError = new Error(`${response.status} ${response.statusText}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  console.warn(`OHP fetch failed for ${url}:`, lastError);
  return null;
}

function extractSlugs(html) {
  const protectedSlugs = new Set();
  const protectedPatterns = [
    /<option[^>]+value=["'](?:https?:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["'][^>]*>\s*Protected:/gi,
    /<a[^>]+href=["'](?:https?:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["'][^>]*>\s*Protected:/gi,
  ];
  for (const pattern of protectedPatterns) {
    for (const match of html.matchAll(pattern)) protectedSlugs.add(match[1]);
  }
  const matches = html.matchAll(/(?:href|value)=["'](?:https?:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["']/gi);
  return [...new Set([...matches].map((match) => match[1]))]
    .filter((slug) => !protectedSlugs.has(slug) && !NON_PROFILE_SLUGS.has(slug))
    .sort();
}

function circularSlice(entries, cursor, count) {
  if (!entries.length || count < 1) return [];
  const size = Math.min(count, entries.length);
  return Array.from({ length: size }, (_, index) => entries[(cursor + index) % entries.length]);
}

function nextFailure(previous) {
  const attempts = (previous?.attempts || 0) + 1;
  const hours = Math.min(24, 2 ** Math.min(attempts, 4));
  return {
    attempts,
    retry_after: new Date(Date.now() + hours * 60 * 60 * 1000).toISOString(),
  };
}

function clean(fragment) {
  const text = fragment.replace(/<[^>]+>/g, " ");
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function parseEntry(slug, html, group) {
  const body = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");
  let name = slug.replace(/-/g, " ").replace(/\b\w/g, (character) => character.toUpperCase());
  const titleMatch = body.match(/<title>([\s\S]*?)<\/title>/i);
  if (titleMatch) {
    const raw = clean(titleMatch[1]).split(/\s*[–\-|]\s*CRESTWOOD/i)[0].trim();
    if (raw && !/welcome/i.test(raw)) name = formatName(raw);
  }
  const contentMatch = body.match(/class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/i);
  const excerpt = contentMatch
    ? contentMatch[1].split(/<(?:div|section)\b[^>]*\bid=["']ohp-(?:video|photo)["']/i)[0]
    : "";
  let text = clean(excerpt);
  text = text.split(/\bVideos\b/i)[0].trim();
  const protectedPage = /(?:post-password-form|name=["']post_password["'])/i.test(body);
  if (protectedPage) text = "";
  const archiveUrl = `${BASE}/ohp/${slug}/`;
  const canonicalTag = body.match(/<link\b[^>]*\brel=["']canonical["'][^>]*>/i)?.[0] || "";
  const canonicalUrl = decodeEntities(canonicalTag.match(/\bhref=["']([^"']+)["']/i)?.[1] || "");
  const canonicalMatches = !canonicalUrl || canonicalUrl.replace(/^http:/, "https:").replace(/\/$/, "") === archiveUrl.replace(/\/$/, "");
  const profileMedia = parseProfileMedia(body, archiveUrl, name);
  return {
    survivor_id: slug,
    name,
    group,
    conflicts: text || group === "Holocaust Survivors" ? deriveConflicts(group, text) : [],
    archive_url: archiveUrl,
    portrait: selectPortrait(profileMedia.images, name),
    portrait_rights: profileMedia.images[0]?.rights || null,
    profile_media: profileMedia,
    video_count: profileMedia.videos.length,
    video_inventory: videoInventory(profileMedia.videos.map((video) => video.id)),
    video_source_inventory: sourceInventory(profileMedia.videos),
    protected: protectedPage,
    source_public: !protectedPage && Boolean(contentMatch) && canonicalMatches,
    quote_text: sourceBiography(body),
    text,
  };
}

function formatName(raw) {
  if (raw.includes(",")) {
    const [last, first] = raw.split(",", 2).map((part) => part.trim());
    return `${first} ${last}`.trim();
  }
  return raw.trim();
}

function deriveConflicts(group, text) {
  if (group === "Holocaust Survivors") return ["The Holocaust"];
  const found = [];
  if (/\bkorea(n)?\b/i.test(text)) found.push("Korean War");
  if (/\b(world war ii|wwii|second world war|1939|1940|1941|1942|1943|1944|1945|normandy|dieppe|d-?day)\b/i.test(text)) {
    found.push("Second World War");
  }
  if (/\b(world war i|wwi|first world war|1914|1915|1916|1917|1918)\b/i.test(text)) {
    found.push("First World War");
  }
  if (/\b(afghanistan|bosnia|peacekeep|cyprus|suez)\b/i.test(text)) {
    found.push("Peacekeeping & later service");
  }
  if (group === "Military Veterans" && !found.length) found.push("Second World War");
  return found;
}

function selectPortrait(images, name) {
  const nameTokens = new Set((name.toLowerCase().match(/[a-z]{3,}/g) || []));
  const candidates = [];
  for (let order = 0; order < images.length; order++) {
    const image = images[order];
    const url = image.url;
    let score = 0;
    const haystack = `${url} ${image.caption}`.toLowerCase();
    for (const token of nameTokens) if (haystack.includes(token)) score += 6;
    for (const token of ["portrait", "headshot", "profile", "solo"]) {
      if (haystack.includes(token)) score += 4;
    }
    for (const token of ["and", "with", "wife", "husband", "family", "students", "group", "team"]) {
      if (new RegExp(`\\b${token}\\b`).test(haystack)) score -= 3;
    }
    candidates.push({ score, order, url });
  }
  candidates.sort((a, b) => b.score - a.score || a.order - b.order);
  return candidates[0]?.url || null;
}

function extract(text) {
  const aliases = gazetteer.aliases;
  const low = text.toLowerCase();
  const hits = [];
  for (const alias of Object.keys(aliases)) {
    const pattern = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let match;
    while ((match = pattern.exec(low))) hits.push([match.index, match.index + alias.length, alias]);
  }
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const claimed = [];
  const accepted = [];
  const seen = new Set();
  const output = [];
  for (const [start, end, alias] of hits) {
    if (claimed.some(([claimStart, claimEnd]) => start < claimEnd && end > claimStart)) continue;
    const canonical = aliases[alias];
    const previous = accepted[accepted.length - 1];
    if (
      !canonical.includes(",") &&
      previous?.canonical.includes(",") &&
      /^\s*,\s*$/.test(text.slice(previous.end, start))
    ) {
      continue;
    }
    claimed.push([start, end]);
    accepted.push({ end, canonical });
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const context = text.slice(Math.max(0, start - 40), end + 60);
    const yearMatch = context.match(/(19[3-5]\d)/);
    output.push({
      as_written: text.slice(start, end),
      _canonical: canonical,
      date: {
        start: yearMatch ? yearMatch[1] : null,
        end: yearMatch ? yearMatch[1] : null,
        precision: yearMatch ? "year" : "unknown",
      },
      confidence: 0.5,
      verified: false,
      source_quote: sourceSentence(text, start, end),
      _role_context: context,
    });
  }
  let firstAssigned = false;
  for (const waypoint of output) {
    const canonical = waypoint._canonical;
    delete waypoint._canonical;
    const roleContext = { ...waypoint, source_quote: waypoint._role_context };
    delete waypoint._role_context;
    const siteRole = gazetteer.known_sites[canonical];
    const isFirst = (
      !firstAssigned &&
      !siteRole &&
      (!RESETTLEMENT.has(canonical) || hasBirthplaceContext(roleContext))
    );
    waypoint.role = siteRole || (
      isFirst ? "birthplace" : (RESETTLEMENT.has(canonical) ? "resettlement" : "transit")
    );
    waypoint.canonical = canonical;
    if (isFirst) firstAssigned = true;
  }
  return output;
}

function hasBirthplaceContext(waypoint) {
  const name = escapePattern(waypoint.as_written);
  const pattern = new RegExp(
    `(?:\\bborn\\b[^.!?]{0,100}\\b${name}\\b|\\b${name}\\b[^.!?]{0,100}\\bborn\\b)`,
    "i",
  );
  return pattern.test(waypoint.source_quote || "");
}

function orderWaypoints(waypoints) {
  const years = waypoints.map((waypoint) => parseYear(waypoint.date?.start));
  if (years.every((year) => year === null)) {
    return waypoints
      .map((waypoint, index) => [waypoint, index])
      .sort((a, b) => (ROLE_ORDER[a[0].role] ?? 3) - (ROLE_ORDER[b[0].role] ?? 3) || a[1] - b[1])
      .map(([waypoint]) => waypoint);
  }
  const filled = years.slice();
  let last = null;
  for (let index = 0; index < filled.length; index++) {
    if (filled[index] === null) filled[index] = last;
    else last = filled[index];
  }
  let next = null;
  for (let index = filled.length - 1; index >= 0; index--) {
    if (filled[index] === null) filled[index] = next;
    else next = filled[index];
  }
  return waypoints
    .map((waypoint, index) => [waypoint, index, filled[index] === null ? 1e9 : filled[index]])
    .sort((a, b) => a[2] - b[2] || a[1] - b[1])
    .map(([waypoint]) => waypoint);
}

function parseYear(value) {
  const match = String(value || "").match(/(1[89]\d\d|20\d\d)/);
  return match ? parseInt(match[1], 10) : null;
}

function toFeature(record) {
  if (record.protected || record.source_public === false) return null;
  const placed = [];
  for (const extracted of extract(record.text)) {
    const waypoint = repairSourceQuote(extracted, record.quote_text ?? record.text);
    const coordinates = geocodeCache[waypoint.canonical];
    if (coordinates && typeof coordinates.lat === "number") {
      placed.push({ ...waypoint, lat: round(coordinates.lat), lng: round(coordinates.lng) });
    }
  }
  const ordered = orderWaypoints(placed);
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  const birthMatch = record.text.match(/\bborn\b[^.]{0,100}\b(18\d\d|19\d\d|20\d\d)\b/i);
  return {
    type: "Feature",
    geometry: home ? { type: "Point", coordinates: [home.lng, home.lat] } : null,
    properties: {
      survivor_id: record.survivor_id,
      name: record.name,
      is_sample: false,
      group: record.group,
      conflicts: record.conflicts,
      birth_year: birthMatch ? parseInt(birthMatch[1], 10) : null,
      review_status: "pending",
      bio_excerpt: sentenceExcerpt(record.quote_text ?? record.text),
      archive_url: record.archive_url,
      portrait: record.portrait || null,
      portrait_rights: record.portrait ? record.portrait_rights : null,
      portrait_faces: 0,
      ...mergeMediaCoverage({}, record),
      theme_tags: [],
      waypoints: ordered,
    },
  };
}

function mergeFeature(existing, fresh) {
  if (existing.properties.review_status === "reviewed") {
    return {
      ...existing,
      properties: {
        ...existing.properties,
        ...mergeMediaCoverage(existing.properties, fresh.properties),
      },
    };
  }
  const preserveReviewedPlaces = existing.properties.waypoints.some((waypoint) => waypoint.verified);
  const waypoints = preserveReviewedPlaces
    ? mergeSeedQuotes(existing.properties.waypoints, fresh.properties.waypoints)
    : (fresh.properties.waypoints || []);
  const home = waypoints.find((waypoint) => waypoint.role === "birthplace") || waypoints[0];
  return {
    type: "Feature",
    geometry: preserveReviewedPlaces ? existing.geometry : (home
      ? { type: "Point", coordinates: [home.lng, home.lat] }
      : null),
    properties: {
      ...existing.properties,
      ...fresh.properties,
      featured: existing.properties.featured || false,
      media_url: existing.properties.media_url || null,
      portrait: existing.properties.portrait || fresh.properties.portrait || null,
      portrait_rights: existing.properties.portrait_rights || fresh.properties.portrait_rights || null,
      portrait_faces:
        existing.properties.portrait_faces || fresh.properties.portrait_faces || 0,
      ...mergeMediaCoverage(existing.properties, fresh.properties),
      review_status: existing.properties.review_status || "pending",
      theme_tags: existing.properties.theme_tags?.length
        ? existing.properties.theme_tags
        : fresh.properties.theme_tags,
      waypoints,
    },
  };
}

function countGroups(features) {
  const counts = {};
  for (const feature of features) {
    const group = feature.properties.group || "Holocaust Survivors";
    counts[group] = (counts[group] || 0) + 1;
  }
  return counts;
}

function sentenceExcerpt(text, limit = 520) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().replace(/\s*…\s*$/, "");
  if (!clean) return clean;
  const endings = sentenceEndings(clean);
  if (clean.length <= limit) {
    if (/[.!?](?:["”’')\]]+)?$/.test(clean)) return clean;
    if (endings.length) return clean.slice(0, endings[endings.length - 1]).trim();
    return clean;
  }
  const before = endings.filter((end) => end <= limit);
  if (before.length) return clean.slice(0, before[before.length - 1]).trim();
  return endings.length ? clean.slice(0, endings[0]).trim() : clean;
}

function sourceSentence(text, start, end) {
  if (!(start >= 0 && start < end && end <= text.length)) {
    throw new Error("The source span must be inside the source text");
  }
  const endings = sentenceEndings(text);
  const left = Math.max(0, ...endings.filter((boundary) => boundary <= start));
  const right = endings.find((boundary) => boundary >= end) ?? text.length;
  return text.slice(left, right).trim();
}

function repairSourceQuote(waypoint, text) {
  if (waypoint.verified || !text) return waypoint;
  const fragments = (waypoint.source_quote || "").split(/\s*(?:…|\.{3})\s*/).map((part) => part.trim()).filter(Boolean);
  const spans = [];
  let cursor = 0;
  for (const fragment of fragments) {
    const match = text.slice(cursor).match(new RegExp(escapePattern(fragment), "i"));
    if (!match) {
      spans.length = 0;
      break;
    }
    spans.push([cursor + match.index, cursor + match.index + match[0].length]);
    cursor += match.index + match[0].length;
  }
  if (spans.length) {
    return { ...waypoint, source_quote: sourceSentence(text, spans[0][0], spans[spans.length - 1][1]) };
  }
  const matches = waypoint.as_written
    ? [...text.matchAll(new RegExp(`\\b${escapePattern(waypoint.as_written)}\\b`, "gi"))] : [];
  return matches.length === 1 ? {
    ...waypoint,
    source_quote: sourceSentence(text, matches[0].index, matches[0].index + matches[0][0].length),
  } : waypoint;
}

const SENTENCE_ABBREVIATIONS = new Set([
  "adm", "apr", "assoc", "aug", "ave", "blvd", "brig", "ca", "capt",
  "cmdr", "co", "col", "corp", "cpl", "dec", "dept", "dr", "ed", "est",
  "etc", "feb", "fig", "ft", "gen", "hon", "inc", "jan", "jr", "jul",
  "jun", "lt", "ltd", "maj", "mar", "mr", "mrs", "ms", "mt", "no",
  "nov", "oct", "pm", "prof", "pvt", "rd", "rev", "sep", "sept", "sgt",
  "sqn", "sr", "st", "vol", "vs",
]);

function sentenceEndings(text) {
  const endings = [];
  for (const match of text.matchAll(/[.!?](?:["”’')\]]+)?(?=\s|$)|(?<=\d{4})\.(?=[A-Z][a-z])/g)) {
    const end = match.index + match[0].length;
    if (match[0].startsWith(".") && end < text.length) {
      const tokenMatch = text.slice(0, end).match(/([A-Za-z][A-Za-z.]*)\.$/);
      const token = tokenMatch?.[1].toLowerCase().replaceAll(".", "") || "";
      if (SENTENCE_ABBREVIATIONS.has(token) || /^(?:[A-Za-z]\.){1,5}$/.test(tokenMatch?.[0] || "")) {
        continue;
      }
    }
    endings.push(end);
  }
  return endings;
}

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
