// The cron-side refresh (doc 09 Part 2.4–2.5): scrape the OHP archive, diff against
// what KV already has, enrich only NEW survivors, and write a merged GeoJSON back.
//
// It reuses the SAME committed gazetteer + geocode cache the Python pipeline uses, so
// place normalization and coordinates match exactly. New survivors are always staged
// verified:false — auto-detected, never auto-asserted as fact.
import gazetteer from "../data/gazetteer.json";
import geocodeCache from "../data/geocode_cache.json";

const BASE = "https://ohp.crestwood.on.ca";
const LISTING = `${BASE}/ohp-type/holocaust-survivors/`;
const UA = "CrestwoodOHP-Map-Worker/1.0 (+https://github.com/AlexDongzeyu/OHP-Map)";
const DATA_KEY = "survivors.geojson";

const RESETTLEMENT = new Set([
  "Toronto, Canada", "Canada", "Montreal, Canada", "Israel",
  "New York, USA", "Vienna, Austria", "Switzerland", "Italy",
]);
const ROLE_ORDER = { birthplace: 0, ghetto: 1, camp: 2, transit: 3, liberation: 4, resettlement: 5 };

export async function syncSurvivors(env) {
  if (!env.OHP_DATA) return { skipped: "no KV namespace bound" };
  const slugs = await listSlugs();
  const existing = await env.OHP_DATA.get(DATA_KEY, "json");
  const features = existing && existing.features ? existing.features : [];
  const known = new Set(features.map((f) => f.properties.survivor_id));

  let added = 0;
  for (const slug of slugs) {
    if (known.has(slug)) continue; // only enrich NEW survivors (cheap diff)
    const page = await fetchText(`${BASE}/ohp/${slug}/`);
    if (!page) continue;
    const rec = parseEntry(slug, page);
    if (!rec.text) continue;
    const feature = toFeature(rec);
    if (feature) {
      features.push(feature);
      known.add(slug);
      added++;
    }
  }

  const doc = {
    type: "FeatureCollection",
    metadata: {
      generator: "worker/sync.js",
      source: "scrape",
      count: features.length,
      reviewed: features.filter((f) => f.properties.review_status === "reviewed").length,
      pending: features.filter((f) => f.properties.review_status !== "reviewed").length,
      time_min: 1933,
      time_max: 1950,
      sample_data: false,
      refreshed_at: new Date().toISOString(),
      notice:
        "Pending records are auto-extracted from public archive summaries and await " +
        "human verification and permission; they are not authoritative.",
    },
    features,
  };
  await env.OHP_DATA.put(DATA_KEY, JSON.stringify(doc));
  return { added, total: features.length };
}

// ---- scraping ---------------------------------------------------------------

async function fetchText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA } });
      if (r.ok) return await r.text();
    } catch (_) { /* retry */ }
  }
  return null;
}

async function listSlugs() {
  const html = await fetchText(LISTING);
  if (!html) return [];
  const re = /href="https:\/\/ohp\.crestwood\.on\.ca\/ohp\/([a-z0-9-]+)\//g;
  return [...new Set([...html.matchAll(re)].map((m) => m[1]))].sort();
}

function clean(fragment) {
  const txt = fragment.replace(/<[^>]+>/g, " ");
  return decodeEntities(txt).replace(/\s+/g, " ").trim();
}

function decodeEntities(s) {
  return s
    .replace(/&#8211;/g, "–").replace(/&#8217;/g, "’").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#039;/g, "'");
}

function parseEntry(slug, html) {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ");
  let name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const tm = body.match(/<title>([\s\S]*?)<\/title>/);
  if (tm) {
    const raw = clean(tm[1]).split(/\s*[–\-|]\s*CRESTWOOD/i)[0].trim();
    if (raw && !/welcome/i.test(raw)) name = formatName(raw);
  }
  const cm = body.match(/class="[^"]*entry-content[^"]*"[^>]*>([\s\S]*?)<\/div>/);
  let text = cm ? clean(cm[1]) : "";
  text = text.split(/\bVideos\b/)[0].trim();
  return { survivor_id: slug, name, archive_url: `${BASE}/ohp/${slug}/`, text };
}

function formatName(raw) {
  if (raw.includes(",")) {
    const [last, first] = raw.split(",", 2).map((p) => p.trim());
    return `${first} ${last}`.trim();
  }
  return raw.trim();
}

// ---- extraction (port of pipeline/extract.OfflineExtractor) ------------------

function extract(text) {
  const aliases = gazetteer.aliases;
  const low = text.toLowerCase();
  const hits = [];
  for (const alias of Object.keys(aliases)) {
    let idx = 0;
    const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
    let m;
    while ((m = re.exec(low))) hits.push([m.index, m.index + alias.length, alias]);
  }
  hits.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));
  const claimed = [], seen = new Set(), out = [];
  for (const [start, end, alias] of hits) {
    if (claimed.some(([cs, ce]) => start < ce && end > cs)) continue;
    claimed.push([start, end]);
    const canonical = aliases[alias];
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    const window = text.slice(Math.max(0, start - 40), end + 60);
    const ym = window.match(/(19[3-5]\d)/);
    out.push({
      as_written: text.slice(start, end),
      _canonical: canonical,
      date: { start: ym ? ym[1] : null, end: ym ? ym[1] : null, precision: ym ? "year" : "unknown" },
      confidence: 0.5,
      verified: false,
      source_quote: window.trim(),
    });
  }
  let firstAssigned = false;
  for (const wp of out) {
    const canonical = wp._canonical;
    delete wp._canonical;
    const siteRole = gazetteer.known_sites[canonical];
    const isFirst = !firstAssigned && !siteRole && !RESETTLEMENT.has(canonical);
    wp.role = siteRole || (RESETTLEMENT.has(canonical) ? "resettlement" : (isFirst ? "birthplace" : "transit"));
    wp.canonical = canonical;
    if (isFirst) firstAssigned = true;
  }
  return out;
}

// ---- geocode + assemble -----------------------------------------------------

function orderWaypoints(wps) {
  const years = wps.map((w) => parseYear(w.date && w.date.start));
  if (years.every((y) => y === null)) {
    return wps
      .map((w, i) => [w, i])
      .sort((a, b) => (ROLE_ORDER[a[0].role] ?? 3) - (ROLE_ORDER[b[0].role] ?? 3) || a[1] - b[1])
      .map(([w]) => w);
  }
  const filled = years.slice();
  let last = null;
  for (let i = 0; i < filled.length; i++) filled[i] === null ? (filled[i] = last) : (last = filled[i]);
  let nxt = null;
  for (let i = filled.length - 1; i >= 0; i--) filled[i] === null ? (filled[i] = nxt) : (nxt = filled[i]);
  return wps
    .map((w, i) => [w, i, filled[i] === null ? 1e9 : filled[i]])
    .sort((a, b) => a[2] - b[2] || a[1] - b[1])
    .map(([w]) => w);
}

function parseYear(t) {
  const m = String(t || "").match(/(1[89]\d\d|20\d\d)/);
  return m ? parseInt(m[1], 10) : null;
}

function toFeature(rec) {
  let wps = extract(rec.text);
  const placed = [];
  for (const wp of wps) {
    const c = geocodeCache[wp.canonical];
    if (c && typeof c.lat === "number") {
      placed.push({ ...wp, lat: round(c.lat), lng: round(c.lng) });
    }
  }
  if (placed.length < 1) return null;
  const ordered = orderWaypoints(placed);
  const home = ordered.find((w) => w.role === "birthplace") || ordered[0];
  return {
    type: "Feature",
    geometry: { type: "Point", coordinates: [home.lng, home.lat] },
    properties: {
      survivor_id: rec.survivor_id,
      name: rec.name,
      is_sample: false,
      review_status: "pending", // auto-detected; pending human verification
      bio_excerpt: rec.text.slice(0, 320),
      archive_url: rec.archive_url,
      theme_tags: [],
      waypoints: ordered,
    },
  };
}

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}
