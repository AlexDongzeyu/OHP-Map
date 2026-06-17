// Data loading + lookups. The browser only ever loads precomputed JSON emitted by
// the pipeline (doc 02 "decouple data from render"). Nothing is geocoded or scraped
// at page load.
import { slug, country } from "./config.js";

const BASE = "data";

async function getJSON(name) {
  const res = await fetch(`${BASE}/${name}`, { cache: "no-cache" });
  if (!res.ok) throw new Error(`Failed to load ${name}: ${res.status}`);
  return res.json();
}

export async function loadData() {
  const [geojson, placeIndex, connections] = await Promise.all([
    getJSON("survivors.geojson"),
    getJSON("place_index.json"),
    getJSON("connections.json"),
  ]);

  const survivors = geojson.features.map((f) => f.properties);
  const byId = new Map(survivors.map((s) => [s.survivor_id, s]));

  // Quick lookups used across modes.
  const places = new Map(); // canonical -> { canonical, lat, lng, roles:Set, slug }
  for (const s of survivors) {
    for (const wp of s.waypoints) {
      if (!places.has(wp.canonical)) {
        places.set(wp.canonical, {
          canonical: wp.canonical,
          lat: wp.lat,
          lng: wp.lng,
          roles: new Set(),
          slug: slug(wp.canonical),
        });
      }
      places.get(wp.canonical).roles.add(wp.role);
    }
  }

  // Facet values for the filter bar (doc 01 F7).
  const camps = new Set();
  const origins = new Set();
  const tags = new Set();
  for (const s of survivors) {
    (s.theme_tags || []).forEach((t) => tags.add(t));
    for (const wp of s.waypoints) {
      if (wp.role === "camp" || wp.role === "ghetto" || wp.role === "transit")
        camps.add(wp.canonical);
      if (wp.role === "birthplace") origins.add(country(wp.canonical));
    }
  }

  // Connections grouped by survivor for the side panel.
  const connBySurvivor = new Map();
  for (const c of connections) {
    for (const sid of [c.survivorA, c.survivorB]) {
      if (!connBySurvivor.has(sid)) connBySurvivor.set(sid, []);
      connBySurvivor.get(sid).push(c);
    }
  }

  return {
    meta: geojson.metadata || {},
    geojson,
    survivors,
    byId,
    placeIndex,
    connections,
    connBySurvivor,
    places,
    facets: {
      camps: [...camps].sort(),
      origins: [...origins].sort(),
      tags: [...tags].sort(),
    },
    placeBySlug: new Map([...places.values()].map((p) => [p.slug, p])),
  };
}
