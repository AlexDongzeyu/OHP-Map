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
export const CONTENT_REVISION = "source-grounded-journeys-v6";
export const JOURNEY_REVISION = "source-evidence-v1";
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

    const features = [...featuresById.values()].map(withLocationPrecision);
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
    features: cached.features.map((original) => {
      const feature = withLocationPrecision(original);
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
  const features = current.features.map(withLocationPrecision);
  if (features.some((feature, index) => feature !== current.features[index])) {
    current = { ...current, features };
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
    const replaceJourney = !hasReviewedPlaces &&
      seedFeature.properties.journey_revision === JOURNEY_REVISION &&
      existing.properties.journey_revision !== JOURNEY_REVISION;
    const replaceGeography = (geographyChanged || replaceJourney) && !hasReviewedPlaces;
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
        ...(replaceJourney ? {
          journey_revision: JOURNEY_REVISION,
          birth_year: seedFeature.properties.birth_year,
          birth_date: seedFeature.properties.birth_date,
          conflicts: seedFeature.properties.conflicts,
          contextual_places: seedFeature.properties.contextual_places || [],
        } : {}),
        ...(hasReviewedPlaces ? {
          journey_revision: existing.properties.journey_revision,
          birth_date: existing.properties.birth_date,
          contextual_places: existing.properties.contextual_places || [],
        } : {}),
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
    const sanitized = geographyChanged || cached.metadata?.content_revision !== CONTENT_REVISION
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
    features: features.map(withLocationPrecision),
  };
}

function withLocationPrecision(feature) {
  let changed = false;
  const properties = { ...feature.properties };
  for (const key of ["waypoints", "contextual_places"]) {
    if (!properties[key]) continue;
    properties[key] = properties[key].map((waypoint) => {
      const updated = withWaypointLocationMetadata(waypoint, feature.properties.review_status === "reviewed");
      if (updated !== waypoint) changed = true;
      return updated;
    });
  }
  return changed ? { ...feature, properties } : feature;
}

function withWaypointLocationMetadata(waypoint, reviewedRecord = false) {
  const coordinates = geocodeCache[waypoint.canonical] || {};
  const metadata = { location_precision: coordinates.precision || "unknown" };
  const fields = [
    ["note", "location_note"],
    ["source_url", "location_source_url"],
    ["coordinate_source_url", "location_coordinate_source_url"],
  ];
  for (const [source, output] of fields) {
    if (typeof coordinates[source] === "string" && coordinates[source]) metadata[output] = coordinates[source];
  }
  const updated = { ...waypoint };
  let changed = false;
  for (const key of ["location_precision", ...fields.map(([, output]) => output)]) {
    if ((reviewedRecord || waypoint.verified) && Object.hasOwn(waypoint, key)) continue;
    if (Object.hasOwn(metadata, key)) {
      if (waypoint[key] !== metadata[key]) {
        updated[key] = metadata[key];
        changed = true;
      }
    } else if (Object.hasOwn(waypoint, key)) {
      delete updated[key];
      changed = true;
    }
  }
  return changed ? updated : waypoint;
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
  if (feature.properties.waypoints.some((waypoint) => waypoint.verified)) return withLocationPrecision(feature);
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
  const contextual = [...(feature.properties.contextual_places || [])];
  const rerolled = [];
  for (const waypoint of waypoints) {
    const source = extractEvidence(waypoint.source_quote || "", feature.properties.name || "");
    const context = source.contextual_places.find((place) => place.canonical === waypoint.canonical);
    const personal = source.waypoints.find((place) => place.canonical === waypoint.canonical);
    if (context && !personal) {
      contextual.push({ ...waypoint, ...context, location_precision: geocodeCache[waypoint.canonical]?.precision || "unknown" });
      continue;
    }
    rerolled.push({
      ...waypoint,
      ...(personal || {
        evidence: { scope: "uncertain", reason: "source-context-unavailable" },
        ...(waypoint.role === "birthplace" ? { role: "transit" } : {}),
      }),
      location_precision: geocodeCache[waypoint.canonical]?.precision || "unknown",
    });
  }
  const ordered = orderWaypoints(rerolled);
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  return withLocationPrecision({
    ...feature,
    geometry: home ? { type: "Point", coordinates: [home.lng, home.lat] } : null,
    properties: {
      ...feature.properties,
      bio_excerpt: sentenceExcerpt(feature.properties.bio_excerpt || ""),
      waypoints: ordered,
      contextual_places: contextual,
    },
  });
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
    conflicts: text || group === "Holocaust Survivors" ? deriveConflicts(group, text, name) : [],
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

function deriveConflicts(group, text, name = "") {
  if (group === "Holocaust Survivors") return ["The Holocaust"];
  const patterns = [
    ["Korean War", /\b(?:Korean War|Korea)\b/i],
    ["Second World War", /\b(?:world war ii|wwii|second world war|normandy|dieppe|d-?day)\b/i],
    ["First World War", /\b(?:world war i|wwi|first world war|great war)\b/i],
    ["Cold War", /\bcold war\b/i],
    ["Peacekeeping & later service", /\b(?:afghanistan|bosnia|peacekeep\w*|cyprus|suez)\b/i],
  ];
  const eligible = clauseSpans(text).map(([left, right]) => text.slice(left, right)).filter(
    (clause) => scopeFor(clause, "", name).scope !== "contextual" && !/\bborn\b/i.test(clause),
  );
  return patterns.filter(([, pattern]) => eligible.some((clause) => pattern.test(clause))).map(([label]) => label);
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

function placeHits(text) {
  const aliases = gazetteer.aliases;
  const low = text.toLowerCase();
  const hits = [];
  for (const alias of Object.keys(aliases)) {
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}_])${escapePattern(alias)}(?![\\p{L}\\p{N}_])`, "gu");
    let match;
    while ((match = pattern.exec(low))) hits.push([match.index, match.index + alias.length, alias]);
  }
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const claimed = [];
  const accepted = [];
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
    accepted.push({ start, end, canonical });
  }
  return accepted;
}

function clauseSpans(text) {
  const endings = [0, ...sentenceEndings(text)];
  if (endings[endings.length - 1] !== text.length) endings.push(text.length);
  const patterns = [
    /;\s*|(?:,\s*)?\b(?:and|but|while|where|when|before|after|as)\s+(?=(?:he|she|they|we|I|his|her|their|my|our)\b)|(?:,\s*)?\b(?:and(?:\s+then)?|then|before|after)\s+(?=(?:later\s+|finally\s+)?(?:mov(?:ed|ing)|sett(?:led|ling)|arriv(?:ed|ing)|return(?:ed|ing)|travell?(?:ed|ing)|went|came|fled|escaped|serv(?:ed|ing)|liv(?:ed|ing)|grew up|was raised|immigrat(?:ed|ing)|emigrat(?:ed|ing)|work(?:ed|ing))\b)/gi,
    /(?:,\s*|\b(?:and|but|before|after|when|while|where|as)\s+)(?=[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+(?:was|were|had|has|is|faced|went|came|moved|served|worked|joined|found|recalled)\b)/g,
  ];
  const spans = [];
  for (let index = 0; index < endings.length - 1; index++) {
    const left = endings[index], sentence = text.slice(left, endings[index + 1]);
    const cuts = [...new Set([0, sentence.length, ...patterns.flatMap(
      (pattern) => [...sentence.matchAll(pattern)].filter((match) => !(
        /\b(?:[A-Z][a-z]+|[Hh]e|[Ss]he|I|[Ww]e|[Tt]hey)\s*$/.test(sentence.slice(0, match.index)) &&
        /^(?:his|her|their|my|our)\s+(?:family|parents?|father|mother)\b/i.test(sentence.slice(match.index + match[0].length)) &&
        /\band\s+$/i.test(match[0])
      )).map((match) => match.index + match[0].length),
    )])].sort((a, b) => a - b);
    for (let part = 0; part < cuts.length - 1; part++) {
      if (sentence.slice(cuts[part], cuts[part + 1]).trim()) spans.push([left + cuts[part], left + cuts[part + 1]]);
    }
  }
  return spans;
}

function unknownDate(asWritten) {
  return { start: null, end: null, precision: "unknown", ...(asWritten ? { as_written: asWritten } : {}) };
}

function dateMentions(text) {
  const year = String.raw`(?:1[6-9]\d{2}|20\d{2})`;
  const month = String.raw`(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\.?`;
  const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const pattern = new RegExp(
    String.raw`\b(?<mdy>(?<m1>${month})\s+(?<d1>\d{1,2})(?:st|nd|rd|th)?\s*,?\s+(?<y1>${year}))\b` +
    String.raw`|\b(?<dmy>(?<d2>\d{1,2})(?:st|nd|rd|th)?\s+(?<m2>${month})\s*,?\s+(?<y2>${year}))\b` +
    String.raw`|\b(?<month>(?<m3>${month})\s+(?<y3>${year}))\b` +
    String.raw`|\b(?<range>(?<y4>${year})\s*(?:[-–—]|to)\s*(?<y5>${year}|\d{1,2}))\b` +
    String.raw`|\b(?<decade>${year})['’]?s\b|\b(?<year>${year})\b|(?<!\w)(?<shorthand>['’]?\d{2}['’]?s)\b`, "gi",
  );
  return [...text.matchAll(pattern)].map((match) => {
    const g = match.groups;
    let value = unknownDate(match[0]);
    if (g.mdy || g.dmy) {
      const suffix = g.mdy ? "1" : "2";
      const y = Number(g[`y${suffix}`]), m = months.indexOf(g[`m${suffix}`].slice(0, 3).toLowerCase()), d = Number(g[`d${suffix}`]);
      const calendar = new Date(Date.UTC(y, m, d));
      if (calendar.getUTCFullYear() === y && calendar.getUTCMonth() === m && calendar.getUTCDate() === d) {
        const token = `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
        value = { start: token, end: token, precision: "day" };
      }
    } else if (g.month) {
      const token = `${g.y3}-${String(months.indexOf(g.m3.slice(0, 3).toLowerCase()) + 1).padStart(2, "0")}`;
      value = { start: token, end: token, precision: "month" };
    } else if (g.range) {
      const end = g.y5.length === 4 ? g.y5 : g.y4.slice(0, -g.y5.length) + g.y5;
      if (Number(end) >= Number(g.y4)) value = { start: g.y4, end, precision: "range" };
    } else if (g.decade) {
      if (Number(g.decade) % 10 === 0) value = { start: g.decade, end: String(Number(g.decade) + 9), precision: "range", as_written: match[0] };
    } else if (g.year) {
      value = { start: g.year, end: g.year, precision: "year" };
    }
    const qualifier = text.slice(0, match.index).match(/\b(before|after|until|since|about|around|circa|approximately|early|late|mid)\s*$/i);
    if (qualifier) {
      const literal = text.slice(qualifier.index, match.index + match[0].length);
      value = g.decade && ["early", "late", "mid"].includes(qualifier[1].toLowerCase())
        ? { ...value, as_written: literal } : unknownDate(literal);
    }
    return { start: match.index, end: match.index + match[0].length, value };
  });
}

function namedParticipant(clause, name) {
  const tokens = name.split(/\s+/).filter((token) => token.length > 2);
  if (!tokens.length) return false;
  const person = `\\b(?:${tokens.map(escapePattern).join("|")})\\b(?![’'\\ufffd]s)`;
  const relative = "(?:(?:his|her|their|my|our|the)\\s+)?(?:parents?|father|mother|grandparents?|grandfather|grandmother|ancestors?)\\b";
  return new RegExp(
    `(?:${person}\\s+and\\s+${relative}|${relative}\\s+and\\s+${person}|\\b(?:with|alongside|including|took|taking|brought|bringing)\\s+${person})`,
    "i",
  ).test(clause);
}

function scopeFor(clause, before = "", name = "") {
  const ancestor = clause.match(/(?:^|[,:]\s*|\b(?:and|but)\s+)\s*(?:(?:his|her|their|my|our)\s+|[A-Z][\w’'\ufffd-]*(?:\s+[A-Z][\w’'\ufffd-]*){0,2}(?:[’'\ufffd]s)\s+)(?:\w+\s+)?(?:parents?|father|mother|grandparents?|grandfather|grandmother|ancestors?)\b[^;]*?\b(?:born|was|were|had|became|hailed|came|moved|emigrated|immigrated|lived|served|fought|worked|grew)\b/i);
  const accompanying = /\b(?:with|alongside|including|took|taking|brought|bringing)\s+(?:him|her|me|them|the children)\b|\b(?:he|she|I|we)\s+and\s+(?:his|her|my|our)\b|\band\s+(?:he|she|I)\b/i;
  const hasCompanion = accompanying.test(clause) || namedParticipant(clause, name);
  if (ancestor && !hasCompanion) {
    const preceding = before || clause, remainder = preceding.slice(ancestor.index);
    const childNamed = name.split(/\s+/).some((token) => token.length > 2 &&
      new RegExp(`\\b${escapePattern(token)}\\b(?![’'\\ufffd]s)`, "i").test(preceding.slice(ancestor.index + ancestor[0].length)));
    if (childNamed || /\b(?:family|children|him|them|us|we)\b/i.test(remainder)) return { scope: "uncertain", reason: "family-participation-unspecified" };
    if (!before || ancestor.index + ancestor[0].length <= before.length) return { scope: "contextual", reason: "ancestor-only" };
    return { scope: "uncertain", reason: "subject-not-established" };
  }
  if (/\b(?:his|her|their|my|our)\s+(?:son|daughter|brother|sister|husband|wife|uncle|aunt)\b/i.test(before || clause) && !hasCompanion) return { scope: "uncertain", reason: "relative-subject-unresolved" };
  if (/\b(?:to|of)\s+(?:\w+\s+)?parents\s+(?:from|born in)\s*$/i.test(before)) return { scope: "contextual", reason: "ancestor-origin" };
  if (/\b(?:unlike|compared (?:with|to)|similar to)\s*$/i.test(before)) return { scope: "contextual", reason: "comparison" };
  if (/\b(?:regiment|army|navy|air force)\s+of\s*$/i.test(before)) return { scope: "contextual", reason: "military-unit-name" };
  if (/^\s*(?:In\s+\d{4}\s*,?\s*)?(?:Nazi\s+Germany|Germany|the Nazis|Hitler|the Soviet Union|Japan)\s+(?:had\s+)?(?:invaded|occupied|annexed|attacked)\b/i.test(clause)) return { scope: "contextual", reason: "historical-event" };
  const named = name.split(/\s+/).some((token) => token.length > 2 && new RegExp(`\\b${escapePattern(token)}\\b`, "i").test(clause));
  const action = /\b(?:born|grew up|raised|lived|living|resid(?:ed|es|ing)|sett(?:led|ling)|mov(?:e|ed|ing)|immigrat(?:ed|ing)|emigrat(?:ed|ing)|fled|escap(?:ed|ing)|deport(?:ed|ation)|sent|taken|took|brought|explor(?:e|ed)|arriv(?:ed|ing)|went|came|coming|return(?:ed|ing)|travell?(?:ed|ing)|served|serving|stationed|trained|training|worked|working|studied|attended|visited|survived|liberated|liberation|imprisoned|held|spent|remained|was in|were in|was at|were at|was based|were based|headed|landed)\b/i;
  if (action.test(clause) && (/\b(?:he|she|I|we|they|him|her|his|my|our)\b/i.test(clause) || named || /^\s*(?:Born|[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s+was born)\b/.test(clause))) {
    if (/\b(?:his|her|their|the)\s+family\b/i.test(clause) && !(hasCompanion || /\b(?:he|she|I|we)\b/i.test(clause) || named)) {
      return { scope: "uncertain", reason: "family-membership-unspecified" };
    }
    return { scope: "personal", reason: "explicit-personal-context" };
  }
  return { scope: "uncertain", reason: "subject-not-established" };
}

const NEGATED_BIRTH = /\b(?:not|never)\s+(?:(?:actually|really)\s+)?born\b|\bborn\s+not\s+in\b/i;

function roleFor(canonical, before, after, evidence) {
  const site = gazetteer.known_sites[canonical];
  if (evidence.scope === "contextual") return site || "transit";
  if (/\bborn\b(?:(?!\b(?:from|to|moved|lived|grew|parents)\b).)*\b(?:in|at|is)\b(?:(?!\b(?:from|to|near|outside|moved|moving|lived|living|grew|raised|parents|went|came|settled|trained|served|worked)\b).)*$/i.test(before) && evidence.scope === "personal" && !NEGATED_BIRTH.test(before)) return "birthplace";
  if (/\bliberated\s+(?:at|in|from)\s+(?:(?!\b(?:and|then|before|after|moved|travelled|went|came)\b).)*$/i.test(before)) return "liberation";
  if (site) return site;
  const destination = /\b(?:to|in|at)\b(?:(?!\b(?:from|through|via|towards|of)\b).)*$/i.test(before);
  if (destination && /\b(?:sett(?:led|ling)|immigrat(?:ed|ing)|emigrat(?:ed|ing)|mov(?:ed|ing)|move|relocat(?:ed|ing)|liv(?:ed|ing|es)|resid(?:ed|es|ing)|grew up|raised|made (?:a|their|his|her) home)\b/i.test(before)) return "resettlement";
  if (destination && /\b(?:came|arrived|went|returned|coming|return)\b/i.test(before) && /\bwhere\b[^.!?]*\b(?:remained|lives?|settled|home)\b/i.test(after)) return "resettlement";
  return "transit";
}

function placeDate(clause, hit, hits) {
  const mentions = dateMentions(clause);
  if (!mentions.length) return unknownDate(clause.match(/\bduring\s+the\s+(?:Second|First)\s+World\s+War\b/i)?.[0]);
  const assigned = [];
  for (const date of mentions) {
    const gap = (place) => Math.max(date.start - place.end, place.start - date.end, 0);
    const closest = hits.reduce((best, place) => gap(place) < gap(best) ? place : best, hits[0]);
    const lo = Math.min(hit.start, closest.start), hi = Math.max(hit.end, closest.end);
    let between = clause.slice(lo, hi);
    for (const place of [...hits].reverse()) {
      if (lo <= place.start && place.end <= hi) {
        between = between.slice(0, place.start - lo) + " ".repeat(place.end - place.start) + between.slice(place.end - lo);
      }
    }
    if (closest === hit || /^(?:\s|,|\band\b|\bor\b|\bvia\b|\bthrough\b)+$/i.test(between)) assigned.push(date.value);
  }
  return assigned.length === 1 ? { ...assigned[0] } : unknownDate(
    assigned.length ? mentions.map((date) => clause.slice(date.start, date.end)).join(" / ") : null,
  );
}

function extractEvidence(text, name = "") {
  const hits = placeHits(text), routes = new Map(), contextual = new Map(), births = [];
  for (const [left, right] of clauseSpans(text)) {
    const clause = text.slice(left, right);
    if (/\bborn\b/i.test(clause) && scopeFor(clause, "", name).scope === "personal" && !NEGATED_BIRTH.test(clause)) {
      const values = dateMentions(clause);
      if (values.length === 1) births.push(values[0].value);
    }
    const local = hits.filter((hit) => left <= hit.start && hit.start < right).map(
      (hit) => ({ ...hit, start: hit.start - left, end: hit.end - left }),
    );
    for (const hit of local) {
      const { start, end, canonical } = hit, before = clause.slice(0, start);
      let evidence = scopeFor(clause, before, name);
      const asWritten = text.slice(left + start, left + end);
      const quote = sourceSentence(text, left + start, left + end);
      const role = roleFor(canonical, before, quote.slice(quote.toLowerCase().indexOf(asWritten.toLowerCase()) + end - start), evidence);
      let date = placeDate(clause, hit, local);
      if (/\bborn\b/i.test(clause) && role !== "birthplace" && evidence.scope !== "contextual") {
        date = unknownDate();
        evidence = { scope: "uncertain", reason: "birth-context-not-place-evidence" };
      }
      const waypoint = {
        as_written: asWritten, canonical, role, date,
        confidence: evidence.scope === "personal" ? 0.5 : 0.35,
        verified: false, source_quote: quote, evidence,
      };
      const target = evidence.scope === "contextual" ? contextual : routes, previous = target.get(canonical);
      if (!previous || (target === routes && (
        (role === "birthplace" && previous.role !== "birthplace") ||
        (evidence.scope === "personal" && previous.evidence.scope === "uncertain")
      ))) target.set(canonical, waypoint);
    }
  }
  const exactBirths = new Set(births.filter((value) => ["day", "month", "year"].includes(value.precision)).map((value) => value.start));
  const birthDate = exactBirths.size === 1 ? births.find((value) => exactBirths.has(value.start)) : unknownDate();
  return { waypoints: [...routes.values()], contextual_places: [...contextual.values()], birth_date: birthDate, birth_year: parseYear(birthDate.start) };
}

function extract(text, name = "") {
  return extractEvidence(text, name).waypoints;
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
  const match = String(value || "").match(/(1[6-9]\d\d|20\d\d)/);
  return match ? parseInt(match[1], 10) : null;
}

function toFeature(record) {
  if (record.protected || record.source_public === false) return null;
  const evidence = extractEvidence(record.text, record.name);
  const place = (waypoints) => waypoints.flatMap((extracted) => {
    const waypoint = repairSourceQuote(extracted, record.quote_text ?? record.text);
    const coordinates = geocodeCache[waypoint.canonical];
    return coordinates && typeof coordinates.lat === "number" ? [withWaypointLocationMetadata({
      ...waypoint, lat: round(coordinates.lat), lng: round(coordinates.lng),
    })] : [];
  });
  const ordered = orderWaypoints(place(evidence.waypoints));
  const home = ordered.find((waypoint) => waypoint.role === "birthplace") || ordered[0];
  return {
    type: "Feature",
    geometry: home ? { type: "Point", coordinates: [home.lng, home.lat] } : null,
    properties: {
      survivor_id: record.survivor_id,
      name: record.name,
      is_sample: false,
      group: record.group,
      conflicts: deriveConflicts(record.group, record.text, record.name),
      birth_year: evidence.birth_year,
      birth_date: evidence.birth_date,
      journey_revision: JOURNEY_REVISION,
      review_status: "pending",
      bio_excerpt: sentenceExcerpt(record.quote_text ?? record.text),
      archive_url: record.archive_url,
      portrait: record.portrait || null,
      portrait_rights: record.portrait ? record.portrait_rights : null,
      portrait_faces: 0,
      ...mergeMediaCoverage({}, record),
      theme_tags: [],
      waypoints: ordered,
      contextual_places: place(evidence.contextual_places),
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
      ...(preserveReviewedPlaces ? {
        birth_year: existing.properties.birth_year,
        birth_date: existing.properties.birth_date,
        journey_revision: existing.properties.journey_revision,
        contextual_places: existing.properties.contextual_places || [],
      } : {}),
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
