// Shared configuration: the restrained palette, basemap, and roles live here so the
// rest of the app reads from one place (doc 01 "make it look like it belongs in a
// museum"). No rainbow category colours — grayscale base, one accent for journeys,
// one for the active/selected state.
export const PALETTE = {
  ink: "#33312e",
  paper: "#f4f2ee",
  muted: "#6f6a64",      // resting survivor / waypoint dots
  journey: "#5e7a8c",    // journey lines (single muted accent)
  active: "#b07d52",     // selected / active state (second accent)
  flow: "#5e7a8c",
  link: "#9a8c7a",       // connection-layer links
};

// CARTO Positron — desaturated, built to sit quietly under data (doc 01).
export const BASEMAP = {
  url: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
  options: {
    subdomains: "abcd",
    maxZoom: 19,
    attribution:
      '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> ' +
      'contributors &copy; <a href="https://carto.com/attributions">CARTO</a>',
  },
};

// Optional, off-by-default period overlay. OpenHistoricalMap renders historical
// place-names/borders as accurate cartography (not a stylised "war" look, per doc 08).
// Shown faintly under the data and only when the visitor opts in via the layer control.
export const HISTORICAL_OVERLAY = {
  url: "https://www.openhistoricalmap.org/map-styles/main/main.json",
  tiles: "https://tile.openhistoricalmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openhistoricalmap.org/">OpenHistoricalMap</a> contributors',
  opacity: 0.45,
};

export const ROLE_LABELS = {
  birthplace: "Birthplace",
  ghetto: "Ghetto",
  camp: "Camp",
  transit: "Transit",
  liberation: "Liberation",
  resettlement: "Resettlement",
};

// Time window for the scrubber (doc 01 / F10). Kept in sync with the build metadata.
export const TIME = { min: 1933, max: 1950 };

export const REDUCED_MOTION =
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function country(canonical) {
  // "Auschwitz (Oswiecim), Poland" -> "Poland"
  const parts = String(canonical).split(",");
  return parts[parts.length - 1].trim();
}
