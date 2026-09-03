// Hourly archive refresh: check every OHP category for additions, then refresh a bounded
// rotating batch of existing profiles. New data is auto-extracted and remains unverified.
import gazetteer from "../data/gazetteer.json";
import geocodeCache from "../data/geocode_cache.json";

const BASE = "https://ohp.crestwood.on.ca";
const UA = "CrestwoodOHP-Map-Worker/2.0 (+https://github.com/AlexDongzeyu/OHP-Map)";
export const DATA_KEY = "survivors.geojson";
export const STATUS_KEY = "ohp-sync-status.json";
export const GAZETTEER_REVISION = gazetteer.revision;
const SEEN_KEY = "ohp-seen-slugs.json";
const FAILURE_KEY = "ohp-fetch-failures.json";
const CURSOR_KEY = "ohp-refresh-cursor";
const DETAIL_BUDGET = 30;
const RUN_LOCK_MINUTES = 15;
const RIGHTS = (
  "Reuse permission granted by the photograph author and project owner " +
  "on 2026-09-02 for the OHP Map."
);

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
  "New York, USA", "Vienna, Austria", "Switzerland", "Italy",
]);
const ROLE_ORDER = { birthplace: 0, ghetto: 1, camp: 2, transit: 3, liberation: 4, resettlement: 5 };

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
    const seen = new Set(Array.isArray(seenDoc) ? seenDoc : featuresById.keys());
    const failures = (await env.OHP_DATA.get(FAILURE_KEY, "json")) || {};
    const listed = await listArchiveEntries();
    const newlyListed = listed.filter((entry) => !seen.has(entry.slug));
    const eligibleNew = newlyListed.filter((entry) => (
      !failures[entry.slug] ||
      Date.parse(failures[entry.slug].retry_after) <= Date.now()
    ));
    const newBatch = eligibleNew.slice(0, DETAIL_BUDGET);

    const refreshable = listed.filter((entry) => (
      seen.has(entry.slug) &&
      featuresById.get(entry.slug)?.properties?.review_status !== "reviewed"
    ));
    const cursor = Number(await env.OHP_DATA.get(CURSOR_KEY)) || 0;
    const refreshSlots = Math.max(0, DETAIL_BUDGET - newBatch.length);
    const refreshBatch = circularSlice(refreshable, cursor, refreshSlots);
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
      delete failures[entry.slug];
      seen.add(entry.slug);
      const record = parseEntry(entry.slug, html, entry.group);
      if (!record.text) {
        unplaced++;
        continue;
      }
      const fresh = toFeature(record);
      if (!fresh) {
        unplaced++;
        continue;
      }

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
    const nextCursor = refreshable.length
      ? (cursor + refreshBatch.length) % refreshable.length
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
        count: features.length,
        groups,
        group_order: GROUP_ORDER,
        reviewed: features.filter((feature) => feature.properties.review_status === "reviewed").length,
        pending: features.filter((feature) => feature.properties.review_status !== "reviewed").length,
        sample_data: false,
        refreshed_at: completedAt,
        notice:
          "Auto-extracted records require human verification and permission; " +
          "the source archive remains authoritative.",
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
      deferred_failures: newlyListed.length - eligibleNew.length,
      added,
      updated,
      unplaced,
      failed,
      total: features.length,
      groups,
      gazetteer_revision: GAZETTEER_REVISION,
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
  if (cached.metadata?.gazetteer_revision !== GAZETTEER_REVISION) {
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
      if (!seeded?.portrait || feature.properties.portrait) return feature;
      return {
        ...feature,
        properties: {
          ...feature.properties,
          portrait: seeded.portrait,
          portrait_rights: seeded.portrait_rights,
          portrait_faces: seeded.portrait_faces || 0,
        },
      };
    }),
  };
}

export async function ensureCurrentData(env, cached) {
  if (cached.metadata?.gazetteer_revision === GAZETTEER_REVISION) return cached;
  const seed = await loadSeedData(env);
  const migrated = migrateCachedData(cached, seed);
  await env.OHP_DATA.put(DATA_KEY, JSON.stringify(migrated));
  return migrated;
}

function migrateCachedData(cached, seed) {
  const cachedById = new Map(
    cached.features.map((feature) => [feature.properties.survivor_id, feature]),
  );
  const seedIds = new Set();
  const features = seed.features.map((seedFeature) => {
    const id = seedFeature.properties.survivor_id;
    seedIds.add(id);
    const existing = cachedById.get(id);
    if (!existing) return seedFeature;
    if (existing.properties.review_status === "reviewed") return existing;
    return {
      ...existing,
      geometry: seedFeature.geometry,
      properties: {
        ...seedFeature.properties,
        ...existing.properties,
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
        waypoints: seedFeature.properties.waypoints,
      },
    };
  });

  for (const feature of cached.features) {
    if (seedIds.has(feature.properties.survivor_id)) continue;
    if (feature.properties.review_status === "reviewed") {
      features.push(feature);
      continue;
    }
    const sanitized = sanitizeCachedFeature(feature);
    if (sanitized) features.push(sanitized);
  }

  const reviewed = features.filter(
    (feature) => feature.properties.review_status === "reviewed",
  ).length;
  return {
    ...cached,
    metadata: {
      ...(cached.metadata || {}),
      count: features.length,
      groups: countGroups(features),
      reviewed,
      pending: features.length - reviewed,
      gazetteer_revision: GAZETTEER_REVISION,
      migrated_at: new Date().toISOString(),
    },
    features,
  };
}

function sanitizeCachedFeature(feature) {
  const seen = new Set();
  const waypoints = [];
  for (const waypoint of feature.properties.waypoints || []) {
    const key = String(waypoint.as_written || "")
      .trim().toLowerCase().replace(/\s+/g, " ").replace(/^[\s.,;:]+|[\s.,;:]+$/g, "");
    const canonical = gazetteer.aliases[key];
    const coordinates = geocodeCache[canonical];
    if (!canonical || !coordinates || seen.has(canonical)) continue;
    seen.add(canonical);
    waypoints.push({
      ...waypoint,
      canonical,
      role: gazetteer.known_sites[canonical] || waypoint.role,
      lat: round(coordinates.lat),
      lng: round(coordinates.lng),
    });
  }
  if (!waypoints.length) return null;
  const ordered = orderWaypoints(waypoints);
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  return {
    ...feature,
    geometry: { type: "Point", coordinates: [home.lng, home.lat] },
    properties: { ...feature.properties, waypoints: ordered },
  };
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
    /<option[^>]+value=["'](?:https:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["'][^>]*>\s*Protected:/gi,
    /<a[^>]+href=["'](?:https:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["'][^>]*>\s*Protected:/gi,
  ];
  for (const pattern of protectedPatterns) {
    for (const match of html.matchAll(pattern)) protectedSlugs.add(match[1]);
  }
  const matches = html.matchAll(/href=["'](?:https:\/\/ohp\.crestwood\.on\.ca)?\/ohp\/([a-z0-9-]+)\/?["']/gi);
  return [...new Set([...matches].map((match) => match[1]))]
    .filter((slug) => !protectedSlugs.has(slug))
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

function decodeEntities(value) {
  return value
    .replace(/&#8211;/g, "–").replace(/&#8217;/g, "’").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#039;/g, "'");
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
  let text = contentMatch ? clean(contentMatch[1]) : "";
  text = text.split(/\bVideos\b/i)[0].trim();
  return {
    survivor_id: slug,
    name,
    group,
    conflicts: deriveConflicts(group, text),
    archive_url: `${BASE}/ohp/${slug}/`,
    portrait: selectPortrait(body, name),
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

function selectPortrait(html, name) {
  const nameTokens = new Set((name.toLowerCase().match(/[a-z]{3,}/g) || []));
  const candidates = [];
  const imageTags = html.match(/<img\b[^>]*>/gi) || [];
  for (let order = 0; order < imageTags.length; order++) {
    const tag = imageTags[order];
    const sourceMatch = tag.match(/\b(?:src|data-src)=["']([^"']+)["']/i);
    if (!sourceMatch) continue;
    const url = decodeEntities(sourceMatch[1]);
    if (!url.includes("/wp-content/uploads/")) continue;
    let score = /attachment-thumbnail/i.test(tag) ? 2 : 0;
    const haystack = tag.toLowerCase();
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
  const seen = new Set();
  const output = [];
  for (const [start, end, alias] of hits) {
    if (claimed.some(([claimStart, claimEnd]) => start < claimEnd && end > claimStart)) continue;
    claimed.push([start, end]);
    const canonical = aliases[alias];
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
      source_quote: context.trim(),
    });
  }
  let firstAssigned = false;
  for (const waypoint of output) {
    const canonical = waypoint._canonical;
    delete waypoint._canonical;
    const siteRole = gazetteer.known_sites[canonical];
    const isFirst = !firstAssigned && !siteRole && !RESETTLEMENT.has(canonical);
    waypoint.role = siteRole || (RESETTLEMENT.has(canonical) ? "resettlement" : (isFirst ? "birthplace" : "transit"));
    waypoint.canonical = canonical;
    if (isFirst) firstAssigned = true;
  }
  return output;
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
  const placed = [];
  for (const waypoint of extract(record.text)) {
    const coordinates = geocodeCache[waypoint.canonical];
    if (coordinates && typeof coordinates.lat === "number") {
      placed.push({ ...waypoint, lat: round(coordinates.lat), lng: round(coordinates.lng) });
    }
  }
  if (!placed.length) return null;
  const ordered = orderWaypoints(placed);
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  const birthMatch = record.text.match(/\bborn\b[^.]{0,100}\b(18\d\d|19\d\d|20\d\d)\b/i);
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [home.lng, home.lat] },
    properties: {
      survivor_id: record.survivor_id,
      name: record.name,
      is_sample: false,
      group: record.group,
      conflicts: record.conflicts,
      birth_year: birthMatch ? parseInt(birthMatch[1], 10) : null,
      review_status: "pending",
      bio_excerpt: record.text.slice(0, 320),
      archive_url: record.archive_url,
      portrait: record.portrait || null,
      portrait_rights: record.portrait ? RIGHTS : null,
      portrait_faces: 0,
      theme_tags: [],
      waypoints: ordered,
    },
  };
}

function mergeFeature(existing, fresh) {
  if (existing.properties.review_status === "reviewed") return existing;
  const waypoints = fresh.properties.waypoints || [];
  const home = waypoints.find((waypoint) => waypoint.role === "birthplace") || waypoints[0];
  return {
    type: "Feature",
    geometry: home
      ? { type: "Point", coordinates: [home.lng, home.lat] }
      : existing.geometry,
    properties: {
      ...existing.properties,
      ...fresh.properties,
      featured: existing.properties.featured || false,
      media_url: existing.properties.media_url || null,
      portrait: existing.properties.portrait || fresh.properties.portrait || null,
      portrait_rights: existing.properties.portrait_rights || fresh.properties.portrait_rights || null,
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

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}
