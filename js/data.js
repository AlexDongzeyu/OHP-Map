// Data loading + adaptation. The browser only ever loads precomputed JSON emitted by
// the pipeline. This reshapes survivors.geojson into the "journey" model the atlas + UI
// render: surname (for A–Z grouping like the OHP site), a one-line intro, per-waypoint
// year/uncertainty, theme facets, origin-country counts (for the choropleth), and the
// shared persecution sites. Survivors' as-written place names are preserved throughout.
import { ROLE_LABEL, OVERSEAS, parseYear, initials, slug, TIME } from "./config.js";

const BASE = "data";

// Historical → modern country aliases so origins match the atlas country names.
const COUNTRY_ALIAS = { Czechoslovakia: "Czechia", Galicia: "Poland" };

async function getJSON(name) {
  const res = await fetch(`${BASE}/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}

function countryOf(canonical) {
  const parts = String(canonical || "").split(",");
  const c = parts[parts.length - 1].trim();
  return COUNTRY_ALIAS[c] || c;
}

function surnameOf(name) {
  const clean = String(name).replace(/\(sample\)/i, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
}

function shortIntro(j) {
  // A single gentle sentence for the rail card.
  const bits = [];
  if (j.hometown) bits.push(`From ${j.hometown.split(",")[0]}`);
  const camps = j.waypoints.filter((w) => w.roleKey === "camp").map((w) => w.canonical.split(" (")[0]);
  if (camps.length) bits.push(`survived ${camps.slice(0, 2).join(" and ")}`);
  const last = j.waypoints[j.waypoints.length - 1];
  if (last && (last.newLife || last.overseas)) bits.push("rebuilt a life in Toronto");
  let s = bits.join(", ");
  if (!s) s = (j.bio || "").split(". ")[0];
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + "." : "";
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
  const j = {
    id: props.survivor_id,
    name: props.name,
    surname: surnameOf(props.name),
    born: props.birth_year || (home && home.year) || null,
    hometown: home ? (home.canonical || home.asWritten) : "",
    originCountry: home ? countryOf(home.canonical) : null,
    initials: initials(props.name),
    themes: props.theme_tags || [],
    bio: props.bio_excerpt || "",
    archiveUrl: props.archive_url || "",
    reviewStatus: props.review_status || "pending",
    waypoints: wps,
  };
  j.intro = shortIntro(j);
  return j;
}

export async function loadData() {
  const [geojson, placeIndex, connections] = await Promise.all([
    getJSON("survivors.geojson"),
    getJSON("place_index.json"),
    getJSON("connections.json"),
  ]);

  const journeys = geojson.features.map((f) => toJourney(f.properties));
  journeys.sort((a, b) => a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name));
  const byId = new Map(journeys.map((j) => [j.id, j]));

  // A–Z groups by surname (how the OHP site groups its listings).
  const groups = [];
  let cur = null;
  for (const j of journeys) {
    const letter = (j.surname[0] || "#").toUpperCase();
    if (!cur || cur.letter !== letter) { cur = { letter, items: [] }; groups.push(cur); }
    cur.items.push(j);
  }

  // Theme facets, most common first.
  const themeCount = new Map();
  for (const j of journeys) for (const t of j.themes) themeCount.set(t, (themeCount.get(t) || 0) + 1);
  const themes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

  // Origin-country counts (choropleth) + distinct places (scale line).
  const originCounts = new Map();
  const places = new Set();
  for (const j of journeys) {
    if (j.originCountry) originCounts.set(j.originCountry, (originCounts.get(j.originCountry) || 0) + 1);
    for (const w of j.waypoints) places.add(w.canonical);
  }

  // Default guided survivor: the first with a rich (>=4-waypoint) journey. No "featured".
  const richDefault = journeys.find((j) => j.waypoints.length >= 4) || journeys[0];

  const meta = geojson.metadata || {};
  return {
    meta,
    journeys,
    byId,
    groups,
    placeIndex,
    connections,
    themes,
    originCounts,
    placeCount: places.size,
    shared: sharedPlaces(journeys),
    defaultGuidedId: richDefault ? richDefault.id : (journeys[0] && journeys[0].id),
    time: { min: meta.time_min || TIME.min, max: meta.time_max || TIME.max },
  };
}

function sharedPlaces(journeys) {
  const at = new Map();
  for (const j of journeys) {
    for (const w of j.waypoints) {
      if (!["camp", "ghetto", "transit"].includes(w.roleKey)) continue;
      if (!at.has(w.canonical))
        at.set(w.canonical, { canonical: w.canonical, lat: w.lat, lng: w.lng, role: w.roleKey, ids: new Set() });
      at.get(w.canonical).ids.add(j.id);
    }
  }
  return [...at.values()].map((p) => ({ ...p, count: p.ids.size }))
    .filter((p) => p.count >= 2).sort((a, b) => b.count - a.count);
}

export { slug };
