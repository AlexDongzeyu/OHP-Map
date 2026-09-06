// Data loading + adaptation. The browser only ever loads precomputed JSON emitted by
// the pipeline. This reshapes the people FeatureCollection into the model the atlas +
// UI render: group (the OHP archive category), a one-line intro, conflict facet,
// per-waypoint year/uncertainty, theme facets, origin-country counts (for the density
// choropleth), and the shared persecution sites. As-written place names are preserved.
import { ROLE_LABEL, GROUPS, parseYear, initials, slug, normalizeSearch, siteResource, TIME } from "./config.js";
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

function journeySearchText(journey) {
  return normalizeSearch([
    journey.name, journey.hometown, journey.group, ...journey.conflicts, ...journey.themes,
    ...journey.waypoints.flatMap((place) => [place.canonical, place.asWritten]),
  ].join(" "));
}

export function journeyFilter({ query, groupFilter, originCountry, placeFilter, savedOnly = false, savedIds = new Set(), sharedIds = null }) {
  const term = normalizeSearch(query);
  return (journey) => groupFilter.has(journey.group) &&
    (!originCountry || journey.originCountry === originCountry) &&
    (!placeFilter || journey.waypoints.some((place) => place.canonical === placeFilter)) &&
    (!savedOnly || savedIds.has(journey.id)) &&
    (!sharedIds || sharedIds.has(journey.id)) &&
    (!term || (journey.searchText ?? journeySearchText(journey)).includes(term));
}

export function collectionResults(store, state) {
  const matches = store.journeys.filter(journeyFilter(state));
  const order = new Map(store.groups.map((group, index) => [group.name, index]));
  return matches.sort((a, b) => order.get(a.group) - order.get(b.group));
}

export function collectionPlaces(store, state) {
  const places = new Map();
  for (const journey of collectionResults(store, { ...state, placeFilter: null })) {
    for (const point of journey.waypoints) {
      if (!point.canonical) {
        console.warn("A source reference without a place name cannot appear in the place index.");
        continue;
      }
      if (!places.has(point.canonical)) places.set(point.canonical, {
        name: point.canonical, accounts: new Set(), names: new Set(), precisions: new Set(),
      });
      const place = places.get(point.canonical);
      place.accounts.add(journey.id);
      place.names.add(point.canonical);
      if (point.asWritten) place.names.add(point.asWritten);
      place.precisions.add(point.locationPrecision || "unknown");
    }
  }
  return [...places.values()].map(place => ({
    name: place.name, count: place.accounts.size,
    searchText: normalizeSearch([...place.names].join(" ")),
    precision: place.precisions.size === 1 ? [...place.precisions][0] : "mixed",
  })).sort((a, b) => a.name.localeCompare(b.name));
}

export function evidenceCounts(journey) {
  const counts = { total: journey.waypoints.length, route: 0, broad: 0, review: 0, mapped: 0 };
  for (const place of journey.waypoints) {
    if (Number.isFinite(place.lat) && Number.isFinite(place.lng)) counts.mapped++;
    if (!place.verified && place.evidenceScope !== "personal") counts.review++;
    else if (journey.routeWaypoints.includes(place)) counts.route++;
    else counts.broad++;
  }
  return counts;
}

export function searchSuggestions(store, state) {
  const query = normalizeSearch(state.query);
  if (query.length < 4 || query.length > 60) return [];
  const limit = query.length > 7 ? 2 : 1;
  const labels = new Map();
  for (const journey of store.journeys.filter(journeyFilter({ ...state, query: "" }))) {
    for (const label of [journey.name, ...journey.waypoints.flatMap((place) => [
      place.canonical.split(",")[0], place.asWritten,
      ...place.canonical.split(/[ ,()]+/).filter((word) => word.length > 3),
    ])]) {
      const folded = normalizeSearch(label);
      if (Math.abs(folded.length - query.length) <= limit && folded !== query) labels.set(folded, label);
    }
  }
  const ranked = [];
  for (const [folded, label] of labels) {
    let row = Array.from({ length: folded.length + 1 }, (_, index) => index);
    for (let i = 1; i <= query.length; i++) {
      const next = [i];
      for (let j = 1; j <= folded.length; j++) {
        next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (query[i - 1] === folded[j - 1] ? 0 : 1));
      }
      row = next;
    }
    const distance = row[folded.length];
    if (distance <= limit) ranked.push({ label, distance });
  }
  return ranked.sort((a, b) => a.distance - b.distance || a.label.localeCompare(b.label)).slice(0, 3).map((entry) => entry.label);
}

async function getJSON(name, onRetry, mayRetry = true) {
  let response;
  try {
    const resource = name.startsWith("/data/") ? name.slice(1) : `${BASE}/${name}`;
    response = await fetch(typeof document === "undefined" ? resource : siteResource(resource), { cache: "no-cache" });
    if (response.ok) return await response.json();
  } catch (error) {
    if (!(error instanceof TypeError) || !mayRetry) throw error;
    return retryJSON(name, onRetry, 600);
  }
  const error = new Error(`Failed to load ${name}: ${response.status}`);
  if (!mayRetry || ![502, 503, 504].includes(response.status)) throw error;
  const retryAfter = response.headers.get("retry-after");
  const requestedDelay = retryAfter && (/^\d+$/.test(retryAfter)
    ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
  const delay = Number.isFinite(requestedDelay) ? Math.max(600, requestedDelay) : 600;
  if (delay > 3000) throw error;
  return retryJSON(name, onRetry, delay);
}

async function retryJSON(name, onRetry, delay) {
  console.warn(`Temporary archive request failure; retrying ${name}.`);
  onRetry?.(name);
  await new Promise((resolve) => setTimeout(resolve, delay));
  return getJSON(name, onRetry, false);
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
      humanReview: w.human_review || null,
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
    unplacedCount: props.unplaced_waypoint_count || 0,
    waypoints: wps,
    contextualPlaces,
    detailUrl: props.detail_url || "",
    detailState: props.detail_url ? "unloaded" : "ready",
    detailError: "",
    sourceProperties: props,
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
  j.searchText = journeySearchText(j);
  return j;
}

export async function loadData({ onRetry, compact = false } = {}) {
  const [geojson, placeIndex, connections, warContext, historicalIndex] = await Promise.all([
    getJSON(compact ? "index.json" : "survivors.geojson", onRetry),
    compact ? null : getJSON("place_index.json", onRetry),
    compact ? null : getJSON("connections.json", onRetry),
    getJSON("war_context.json", onRetry),
    getJSON("historical_boundary_index.json", onRetry),
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
  const profileRequests = new Map();
  async function loadProfile(id) {
    const journey = byId.get(id);
    if (!journey) throw new Error("The requested account is not in this collection.");
    if (journey.detailState === "ready") return journey;
    if (profileRequests.has(journey.id)) return profileRequests.get(journey.id);
    if (!/^\/data\/profiles\/[a-z0-9_-]+\.[a-f0-9]{16,64}\.json$/.test(journey.detailUrl)) {
      throw new Error("The account detail address is not a supported archive resource.");
    }
    journey.detailState = "loading";
    journey.detailError = "";
    const request = getJSON(journey.detailUrl, onRetry).then((feature) => {
      if (feature?.type !== "Feature" || feature.properties?.survivor_id !== journey.id ||
          !Array.isArray(feature.properties.waypoints)) {
        throw new Error("The account detail does not match the selected record.");
      }
      const full = toJourney(feature.properties);
      if (full.waypoints.length !== journey.waypoints.length || full.waypoints.some((place, index) => {
        const prior = journey.waypoints[index];
        return place.canonical !== prior.canonical || place.lat !== prior.lat || place.lng !== prior.lng ||
          place.roleKey !== prior.roleKey || place.historyYear !== prior.historyYear;
      })) throw new Error("The account and map index have different revisions. Reload the collection.");
      for (let index = 0; index < full.waypoints.length; index++) {
        Object.assign(full.waypoints[index], { px: journey.waypoints[index].px, py: journey.waypoints[index].py });
      }
      const detailUrl = journey.detailUrl;
      Object.assign(journey, full, { detailUrl, detailState: "ready", detailError: "" });
      return journey;
    }).catch((error) => {
      journey.detailState = "error";
      journey.detailError = error.message;
      throw error;
    }).finally(() => profileRequests.delete(journey.id));
    profileRequests.set(journey.id, request);
    return request;
  }
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
    loadProfile,
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
