// Data loading + adaptation. The browser only ever loads precomputed JSON emitted by
// the pipeline. This module reshapes survivors.geojson into the "journey" model the
// atlas and UI render, deriving initials, themes, a hometown label, and per-waypoint
// year/uncertainty — while preserving each survivor's as-written place names.
import { ROLE_LABEL, OVERSEAS, parseYear, initials, slug, TIME } from "./config.js";

const BASE = "data";

async function getJSON(name) {
  const res = await fetch(`${BASE}/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}

function toJourney(props) {
  const wps = (props.waypoints || []).map((w) => {
    const year = parseYear(w.date && w.date.start) || parseYear(w.date && w.date.end);
    const approx = !w.date || w.date.precision === "range" || w.date.precision === "unknown";
    const overseas = OVERSEAS.test(w.canonical || "") || OVERSEAS.test(w.as_written || "");
    return {
      canonical: w.canonical,
      asWritten: w.as_written,
      roleKey: w.role,
      role: ROLE_LABEL[w.role] || w.role,
      lat: w.lat,
      lng: w.lng,
      year,
      approx,
      liberation: w.role === "liberation",
      newLife: w.role === "resettlement",
      overseas: overseas && (w.role === "resettlement" || w.role === "liberation"),
      verified: !!w.verified,
      quote: w.source_quote || null,
    };
  });
  const home = wps.find((w) => w.roleKey === "birthplace") || wps[0] || null;
  return {
    id: props.survivor_id,
    name: props.name,
    born: props.birth_year || (home && home.year) || null,
    hometown: home ? (home.canonical || home.asWritten) : "",
    initials: initials(props.name),
    themes: props.theme_tags || [],
    bio: props.bio_excerpt || "",
    archiveUrl: props.archive_url || "",
    reviewStatus: props.review_status || "pending",
    featured: !!props.featured,
    waypoints: wps,
  };
}

export async function loadData() {
  const [geojson, placeIndex, connections] = await Promise.all([
    getJSON("survivors.geojson"),
    getJSON("place_index.json"),
    getJSON("connections.json"),
  ]);

  const journeys = geojson.features.map((f) => toJourney(f.properties));
  const byId = new Map(journeys.map((j) => [j.id, j]));

  // Theme facets, most common first (for the filter chips).
  const themeCount = new Map();
  for (const j of journeys)
    for (const t of j.themes) themeCount.set(t, (themeCount.get(t) || 0) + 1);
  const themes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

  // Distinct remembered places (for the scale line).
  const places = new Set();
  for (const j of journeys) for (const w of j.waypoints) places.add(w.canonical);

  // Shared persecution sites: where separate lives crossed the same ground.
  const shared = sharedPlaces(journeys);

  const meta = geojson.metadata || {};
  return {
    meta,
    journeys,
    byId,
    placeIndex,
    connections,
    themes,
    placeCount: places.size,
    shared,
    featured: journeys.filter((j) => j.featured),
    time: { min: meta.time_min || TIME.min, max: meta.time_max || TIME.max },
  };
}

// Places where ≥2 survivors share a camp/ghetto — the "threads that cross" rings.
function sharedPlaces(journeys) {
  const at = new Map(); // canonical -> {lat,lng,role,ids:Set}
  for (const j of journeys) {
    for (const w of j.waypoints) {
      if (!["camp", "ghetto", "transit"].includes(w.roleKey)) continue;
      if (!at.has(w.canonical))
        at.set(w.canonical, { canonical: w.canonical, lat: w.lat, lng: w.lng, role: w.roleKey, ids: new Set() });
      at.get(w.canonical).ids.add(j.id);
    }
  }
  return [...at.values()]
    .map((p) => ({ ...p, count: p.ids.size }))
    .filter((p) => p.count >= 2)
    .sort((a, b) => b.count - a.count);
}

export { slug };
