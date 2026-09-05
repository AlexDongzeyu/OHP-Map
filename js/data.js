// Data loading + adaptation. The browser only ever loads precomputed JSON emitted by
// the pipeline. This reshapes the people FeatureCollection into the model the atlas +
// UI render: group (the OHP archive category), a one-line intro, conflict facet,
// per-waypoint year/uncertainty, theme facets, origin-country counts (for the density
// choropleth), and the shared persecution sites. As-written place names are preserved.
import { ROLE_LABEL, GROUPS, parseYear, initials, slug, normalizeSearch, TIME } from "./config.js";
import { normalizeProfileMedia } from "./media.js";

const BASE = "data";
const COUNTRY_ALIAS = {
  England: "United Kingdom", Scotland: "United Kingdom", "Great Britain": "United Kingdom",
  UK: "United Kingdom", USA: "United States of America", "United States": "United States of America",
  "Hong Kong": "China",
};
const EVENT_ROLE_ORDER = {
  camp: 0,
  ghetto: 1,
  liberation: 2,
  transit: 3,
  resettlement: 4,
  birthplace: 5,
};
const SERVICE_WINDOWS = {
  "First World War": { start: 1914, end: 1918 },
  "Second World War": { start: 1939, end: 1945 },
  "Korean War": { start: 1950, end: 1953 },
};

export function journeyFilter({ query, groupFilter, originCountry }) {
  const term = normalizeSearch(query);
  return (journey) => groupFilter.has(journey.group) &&
    (!originCountry || journey.originCountry === originCountry) &&
    (!term || normalizeSearch([
      journey.name, journey.hometown, journey.group, ...journey.conflicts, ...journey.themes,
      ...journey.waypoints.flatMap((place) => [place.canonical, place.asWritten]),
    ].join(" ")).includes(term));
}

async function getJSON(name) {
  const res = await fetch(`${BASE}/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}

function countryOf(canonical, precision) {
  const parts = String(canonical || "").split(",");
  const c = parts[parts.length - 1].trim();
  if (parts.length === 1 && precision === "region" && !COUNTRY_ALIAS[c]) return null;
  return COUNTRY_ALIAS[c] || c;
}
function surnameOf(name) {
  const clean = String(name).replace(/\(sample\)/i, "").trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : clean;
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
  for (const match of text.matchAll(/[.!?](?:["”’')\]]+)?(?=\s|$)/g)) {
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

function completeExcerpt(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim().replace(/\s*…\s*$/, "");
  if (!clean || /[.!?](?:["”’')\]]+)?$/.test(clean)) return clean;
  const endings = sentenceEndings(clean);
  return endings.length
    ? clean.slice(0, endings[endings.length - 1])
    : `${clean.replace(/[ ,;:-]+$/, "")}.`;
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

function buildVeteranCorridors(journeys) {
  const byConflict = new Map();
  for (const journey of journeys) {
    if (journey.group !== "Military Veterans") continue;
    if (!journey.serviceConflict) continue;
    const waypoints = journey.routeWaypoints.filter((waypoint) => (
      Number.isFinite(waypoint.lat) && Number.isFinite(waypoint.lng)
    ));
    for (let index = 0; index < waypoints.length - 1; index++) {
      const first = waypoints[index];
      const second = waypoints[index + 1];
      if (first.canonical === second.canonical) continue;
      if (!first.historyYear || first.historyYear !== second.historyYear) continue;
      const [a, b] = first.canonical.localeCompare(second.canonical) <= 0
        ? [first, second]
        : [second, first];
      const datedConflicts = journey.serviceConflicts.filter((conflict) => {
        const window = SERVICE_WINDOWS[conflict];
        return first.historyYear >= window.start && first.historyYear <= window.end;
      });
      for (const conflict of datedConflicts) {
        if (!byConflict.has(conflict)) byConflict.set(conflict, new Map());
        const corridors = byConflict.get(conflict);
        const key = `${a.canonical}|${b.canonical}|${first.historyYear}`;
        if (!corridors.has(key)) {
          corridors.set(key, {
            key,
            year: first.historyYear,
            a: { canonical: a.canonical, lat: a.lat, lng: a.lng },
            b: { canonical: b.canonical, lat: b.lat, lng: b.lng },
            people: [],
          });
        }
        const corridor = corridors.get(key);
        if (!corridor.people.includes(journey.id)) corridor.people.push(journey.id);
      }
    }
  }
  return new Map([...byConflict].map(([conflict, corridors]) => [
    conflict,
    [...corridors.values()]
      .map((corridor) => ({ ...corridor, count: corridor.people.length }))
      .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
  ]));
}

function toJourney(props) {
  const group = props.group || "Holocaust Survivors";
  const toPlace = (w) => {
    const startYear = parseYear(w.date && w.date.start);
    const endYear = parseYear(w.date && w.date.end) || startYear;
    const year = startYear || endYear;
    const scope = w.evidence?.scope || (w.verified ? "personal" : "uncertain");
    const historyYear = scope === "personal" && startYear != null && startYear === endYear &&
      ["year", "month", "day"].includes(w.date?.precision) ? startYear : null;
    const approx = !w.date || w.date.precision === "range" || w.date.precision === "unknown";
    return {
      canonical: w.canonical,
      asWritten: w.as_written,
      roleKey: w.role,
      role: ROLE_LABEL[w.role] || w.role,
      lat: w.lat,
      lng: w.lng,
      year,
      historyYear,
      endYear,
      approx,
      locationPrecision: w.location_precision || "unknown",
      locationNote: w.location_note || "",
      locationSourceUrl: w.location_source_url || "",
      locationCoordinateSourceUrl: w.location_coordinate_source_url || "",
      evidenceScope: scope,
      evidenceReason: w.evidence?.reason || "",
      dateAsWritten: w.date?.as_written || "",
      liberation: w.role === "liberation",
      newLife: w.role === "resettlement",
      verified: !!w.verified,
      quote: w.source_quote || null,
    };
  };
  const wps = (props.waypoints || []).map(toPlace);
  const contextualPlaces = (props.contextual_places || []).map(toPlace);
  const home = wps.find((w) => w.roleKey === "birthplace") || null;
  const routeStart = wps.find((point) => point.evidenceScope === "personal" || point.verified) || null;
  const j = {
    id: props.survivor_id,
    sourceAliases: Array.isArray(props.source_aliases) ? props.source_aliases : [],
    name: props.name,
    surname: surnameOf(props.name),
    group,
    conflicts: props.conflicts || [],
    born: props.birth_year || null,
    hometown: home ? (home.canonical || home.asWritten) : "",
    originCountry: routeStart ? countryOf(routeStart.canonical, routeStart.locationPrecision) : null,
    birthplace: home,
    routeStart,
    initials: initials(props.name),
    themes: props.theme_tags || [],
    bio: completeExcerpt(props.bio_excerpt),
    archiveUrl: props.archive_url || "",
    portrait: props.portrait || null,
    portraitRights: props.portrait_rights || null,
    portraitFaces: props.portrait_faces ?? (props.portrait ? 1 : 0),
    videoCount: props.video_count || 0,
    captionedVideoCount: props.captioned_video_count || 0,
    transcriptStatus: props.transcript_status || "none",
    media: normalizeProfileMedia(props.profile_media),
    reviewStatus: props.review_status || "pending",
    waypoints: wps,
    contextualPlaces,
  };
  const datedServicePlaces = wps.filter((point) => !["birthplace", "resettlement"].includes(point.roleKey) && point.historyYear);
  j.serviceConflicts = j.group === "Military Veterans" ? j.conflicts.filter((conflict) => {
    const window = SERVICE_WINDOWS[conflict];
    return window && datedServicePlaces.some((point) => point.year >= window.start && point.year <= window.end);
  }) : [];
  j.serviceConflict = j.serviceConflicts[0] || null;
  if (j.serviceConflict) {
    const window = SERVICE_WINDOWS[j.serviceConflict];
    const serviceYears = datedServicePlaces.map((waypoint) => waypoint.year)
      .filter((year) => year >= window.start && year <= window.end)
      .sort((a, b) => a - b);
    j.serviceYear = serviceYears[Math.floor(serviceYears.length / 2)];
  } else {
    j.serviceYear = null;
  }
  j.intro = shortIntro(j);
  j.routeWaypoints = wps.filter((point) => (
    (point.evidenceScope === "personal" || point.verified) &&
    (["city", "site"].includes(point.locationPrecision) || (point.verified && point.locationPrecision === "unknown"))
  ));
  return j;
}

export async function loadData() {
  const [geojson, placeIndex, connections, warContext, historicalIndex] = await Promise.all([
    getJSON("survivors.geojson"),
    getJSON("place_index.json"),
    getJSON("connections.json"),
    getJSON("war_context.json"),
    getJSON("historical_boundary_index.json"),
  ]);

  const journeys = geojson.features.map((f) => toJourney(f.properties));
  journeys.sort((a, b) => a.surname.localeCompare(b.surname) || a.name.localeCompare(b.name));
  const byId = new Map(journeys.map((j) => [j.id, j]));
  for (const journey of journeys) {
    for (const alias of journey.sourceAliases) if (!byId.has(alias)) byId.set(alias, journey);
  }
  const events = buildEvents(journeys);
  const veteranCorridors = buildVeteranCorridors(journeys);
  const eventsByYear = new Map();
  for (const event of events) {
    if (!eventsByYear.has(event.year)) eventsByYear.set(event.year, []);
    eventsByYear.get(event.year).push(event);
  }

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

  const meta = geojson.metadata || {};
  const warAt = (year) => warContext.periods.find(
    (period) => year >= period.start && year <= period.end,
  ) || null;
  const corridorsForYear = (year) => {
    const conflict = warAt(year)?.archive_conflict;
    return conflict ? (veteranCorridors.get(conflict) || [])
      .filter((corridor) => corridor.count > 1 && corridor.year === year).slice(0, 8) : [];
  };
  const warForJourney = (journey, year = null) => {
    if (!journey?.serviceConflict) return null;
    const dated = year == null ? null : warAt(year);
    if (journey.serviceConflicts.includes(dated?.archive_conflict)) return dated;
    return warAt(journey.serviceYear);
  };
  return {
    meta,
    journeys,
    byId,
    events,
    eventsByYear,
    eventYears: [...eventsByYear.keys()].sort((a, b) => a - b),
    veteranCorridors,
    groups,
    conflicts: [...conflicts.entries()].sort((a, b) => b[1] - a[1]),
    placeIndex,
    connections,
    themes,
    originCounts,
    placeCount: places.size,
    shared: sharedPlaces(journeys),
    time: {
      min: Math.min(meta.time_min || TIME.min, historicalIndex.min_year),
      max: Math.max(meta.time_max || TIME.max, historicalIndex.max_year),
    },
    warContext,
    historicalIndex,
    warAt,
    warForJourney,
    corridorsForYear,
  };
}

function buildEvents(journeys) {
  const grouped = new Map();
  for (const journey of journeys) {
    for (const waypoint of journey.waypoints) {
      if (!waypoint.historyYear || !waypoint.canonical) continue;
      if (waypoint.historyYear < TIME.min || waypoint.historyYear > TIME.max) continue;
      const key = `${waypoint.historyYear}|${waypoint.roleKey}|${waypoint.canonical}`;
      if (!grouped.has(key)) {
        grouped.set(key, {
          key,
          year: waypoint.historyYear,
          place: waypoint.canonical,
          role: waypoint.role,
          roleKey: waypoint.roleKey,
          lat: waypoint.lat,
          lng: waypoint.lng,
          locationPrecision: waypoint.locationPrecision,
          approximate: 0,
          people: [],
          groups: new Set(),
        });
      }
      const event = grouped.get(key);
      if (!event.people.some((person) => person.id === journey.id)) {
        event.people.push({
          id: journey.id,
          name: journey.name,
          portrait: journey.portrait,
          portraitRights: journey.portraitRights,
        });
      }
      if (waypoint.approx) event.approximate++;
      event.groups.add(journey.group);
    }
  }
  return [...grouped.values()].map((event) => ({
    ...event,
    count: event.people.length,
    groups: [...event.groups],
  })).sort((a, b) => (
    a.year - b.year ||
    (EVENT_ROLE_ORDER[a.roleKey] ?? 6) - (EVENT_ROLE_ORDER[b.roleKey] ?? 6) ||
    b.count - a.count ||
    a.place.localeCompare(b.place)
  ));
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
