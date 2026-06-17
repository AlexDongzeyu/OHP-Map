// Data loading + adaptation. The browser only ever loads precomputed JSON emitted by
// the pipeline. This reshapes the people FeatureCollection into the model the atlas +
// UI render: group (the OHP archive category), a one-line intro, conflict facet,
// per-waypoint year/uncertainty, theme facets, origin-country counts (for the density
// choropleth), and the shared persecution sites. As-written place names are preserved.
import { ROLE_LABEL, GROUPS, parseYear, initials, slug, TIME } from "./config.js";

const BASE = "data";
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
  const bits = [];
  if (j.hometown) bits.push(`From ${j.hometown.split(",")[0]}`);
  if (j.group === "Military Veterans") {
    const served = j.waypoints.filter((w) => ["camp", "liberation", "transit"].includes(w.roleKey))
      .map((w) => w.canonical.split(" (")[0].split(",")[0]);
    if (served.length) bits.push(`served at ${[...new Set(served)].slice(0, 2).join(" and ")}`);
  } else {
    const camps = j.waypoints.filter((w) => w.roleKey === "camp").map((w) => w.canonical.split(" (")[0]);
    if (camps.length) bits.push(`survived ${camps.slice(0, 2).join(" and ")}`);
  }
  let s = bits.join(", ");
  if (!s) s = (j.bio || "").split(". ")[0];
  return s ? s.charAt(0).toUpperCase() + s.slice(1) + "." : "";
}

function toJourney(props) {
  const group = props.group || "Holocaust Survivors";
  const wps = (props.waypoints || []).map((w) => {
    const year = parseYear(w.date && w.date.start) || parseYear(w.date && w.date.end);
    const approx = !w.date || w.date.precision === "range" || w.date.precision === "unknown";
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
      verified: !!w.verified,
      quote: w.source_quote || null,
    };
  });
  const home = wps.find((w) => w.roleKey === "birthplace") || wps[0] || null;
  const j = {
    id: props.survivor_id,
    name: props.name,
    surname: surnameOf(props.name),
    group,
    conflicts: props.conflicts || [],
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

  // Counts per archive category (in canonical order) + per conflict.
  const order = (geojson.metadata && geojson.metadata.group_order) || GROUPS.map((g) => g.name);
  const groupCounts = new Map();
  const conflicts = new Map();
  for (const j of journeys) {
    groupCounts.set(j.group, (groupCounts.get(j.group) || 0) + 1);
    for (const c of j.conflicts) conflicts.set(c, (conflicts.get(c) || 0) + 1);
  }
  const groups = order.filter((g) => groupCounts.get(g)).map((name) => ({ name, count: groupCounts.get(name) }));
  // Any groups present but not in the known order, appended.
  for (const [name, count] of groupCounts) if (!order.includes(name)) groups.push({ name, count });

  // Theme facets, most common first.
  const themeCount = new Map();
  for (const j of journeys) for (const t of j.themes) themeCount.set(t, (themeCount.get(t) || 0) + 1);
  const themes = [...themeCount.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t);

  // Origin-country counts (density choropleth) + distinct places (scale line).
  const originCounts = new Map();
  const places = new Set();
  for (const j of journeys) {
    if (j.originCountry) originCounts.set(j.originCountry, (originCounts.get(j.originCountry) || 0) + 1);
    for (const w of j.waypoints) places.add(w.canonical);
  }

  // Default guided person: a survivor with a rich, dated journey (the clearest arc).
  const richDefault = journeys.find((j) => j.group === "Holocaust Survivors" && j.waypoints.length >= 4)
    || journeys.find((j) => j.waypoints.length >= 4) || journeys[0];

  const meta = geojson.metadata || {};
  return {
    meta,
    journeys,
    byId,
    groups,
    conflicts: [...conflicts.entries()].sort((a, b) => b[1] - a[1]),
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
