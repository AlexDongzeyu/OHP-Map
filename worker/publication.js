// Shared by the offline assembler and the Durable Object publisher. HTTP handlers
// only read the resulting catalog or stream the already-validated JSON bodies.
export const INDEX_FORMAT = 1;
export const PROFILE_WRITE_BUDGET = 30;
export const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const DETAIL_PATTERN = /^\/data\/profiles\/([a-z0-9]+(?:-[a-z0-9]+)*)\.([a-f0-9]{64})\.json$/;
export const SEED_CATALOG_PATH = "/data/catalog.json";
export const DEFAULT_ORIGIN = "https://ohpmap.alexdong0414.workers.dev";

const PROPERTY_KEYS = [
  "survivor_id", "source_aliases", "name", "is_sample", "featured", "group",
  "birth_year", "birth_date", "conflicts", "theme_tags", "archive_url",
  "portrait", "portrait_rights", "portrait_faces", "video_count",
  "captioned_video_count", "transcript_status", "review_status", "journey_revision", "unplaced_waypoint_count",
];
const WAYPOINT_KEYS = [
  "canonical", "as_written", "role", "lat", "lng", "date", "verified",
  "confidence", "location_precision",
];

function pick(value, keys) {
  return Object.fromEntries(keys.filter((key) => Object.hasOwn(value, key)).map((key) => [key, value[key]]));
}

export function stableJSON(value) {
  return JSON.stringify(value, (_key, item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return item;
    return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]));
  });
}

export async function contentHash(body) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function profilePath(id, hash) {
  if (typeof id !== "string" || !ID_PATTERN.test(id) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) {
    throw new Error("Invalid public profile identity");
  }
  return `/data/profiles/${id}.${hash}.json`;
}

export function profileKey(id, hash) {
  return profilePath(id, hash).slice(1);
}

export function profileBackupKey(id, hash) {
  return `immutable:${profileKey(id, hash)}`;
}

export function compactFeature(feature, hash) {
  const properties = pick(feature.properties, PROPERTY_KEYS);
  properties.waypoints = (feature.properties.waypoints || []).map((waypoint) => {
    const result = pick(waypoint, WAYPOINT_KEYS);
    if (waypoint.evidence) {
      result.evidence = pick(waypoint.evidence, ["scope"]);
      if (typeof waypoint.evidence.reason === "string") result.evidence.reason = waypoint.evidence.reason.slice(0, 160);
    }
    return result;
  });
  properties.detail_url = profilePath(properties.survivor_id, hash);
  return { type: "Feature", geometry: feature.geometry ?? null, properties };
}

export function catalogAliases(features) {
  const ids = new Set();
  for (const feature of features) {
    const id = feature?.properties?.survivor_id;
    if (typeof id !== "string" || !ID_PATTERN.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate profile ID: ${id}`);
    ids.add(id);
  }
  const aliases = Object.create(null);
  for (const feature of features) {
    const id = feature.properties.survivor_id;
    for (const alias of feature.properties.source_aliases || []) {
      if (alias === id) continue;
      if (typeof alias !== "string" || !ID_PATTERN.test(alias) || ids.has(alias) || (aliases[alias] && aliases[alias] !== id)) {
        throw new Error(`Ambiguous profile alias: ${alias}`);
      }
      aliases[alias] = id;
    }
  }
  return aliases;
}

export async function prepareArchive(doc, version, onProfile = async () => {}) {
  if ((doc?.type && doc.type !== "FeatureCollection") || !Array.isArray(doc?.features)) {
    throw new Error("The public archive must be a FeatureCollection");
  }
  const aliases = catalogAliases(doc.features);
  const profiles = Object.create(null);
  const features = [];
  for (const feature of doc.features) {
    const body = stableJSON(feature);
    const hash = await contentHash(body);
    const id = feature.properties.survivor_id;
    profiles[id] = hash;
    features.push(compactFeature(feature, hash));
    await onProfile({ id, hash, body, feature });
  }
  return {
    index: {
      type: "FeatureCollection",
      metadata: { ...doc.metadata, index_format: INDEX_FORMAT, publication_version: version },
      features,
    },
    catalog: { format: INDEX_FORMAT, version, profiles, aliases, remote: [] },
  };
}

export function validCatalog(catalog) {
  return catalog?.format === INDEX_FORMAT && typeof catalog.version === "string" &&
    catalog.profiles && typeof catalog.profiles === "object" && !Array.isArray(catalog.profiles) &&
    catalog.aliases && typeof catalog.aliases === "object" && !Array.isArray(catalog.aliases);
}

export async function seedCatalog(env) {
  if (!env.ASSETS) return null;
  const response = await env.ASSETS.fetch(new Request(`https://assets.local${SEED_CATALOG_PATH}`));
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Unable to load the bundled profile catalog: ${response.status}`);
  }
  const catalog = await response.json();
  if (!validCatalog(catalog)) throw new Error("The bundled profile catalog is invalid; rebuild the site");
  return catalog;
}

export function siteOrigin(value = DEFAULT_ORIGIN) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("SITE_ORIGIN must be a public HTTP(S) origin");
  }
  return url.origin;
}

export function xmlEscape(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

export function renderSitemap(catalog, origin = DEFAULT_ORIGIN) {
  const base = siteOrigin(origin);
  const urls = ["/", ...Object.keys(catalog.profiles).map((id) => `/survivor/${id}`)];
  return '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
    urls.map((path) => `  <url><loc>${xmlEscape(base + path)}</loc></url>`).join("\n") +
    "\n</urlset>\n";
}
