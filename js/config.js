// Shared configuration — the museum palette, role vocabulary, and small helpers.
// One ember accent over warm archival paper; everything else greyscale (doc 08/11).

export const C = {
  paper: "#F7F4EF",
  paperSoft: "#FBF9F5",
  panel: "#FBF9F5",
  ink: "#1A1A18",
  inkSoft: "#3A352D",
  muted: "#5E574C",
  faint: "#908876",
  line: "#E9E2D4",
  lineSoft: "#EBE4D7",
  rule: "#E3DCCE",
  accent: "#B45F2E",       // the single ember accent — journeys + active state
  accentDeep: "#8F4A22",
  accentSoft: "#9A6A3F",
  accentWash: "#FBF1E8",
  land: "#E4DECF",         // basemap country fill
  landStroke: "#D6CDBB",
  ocean: "#EFEBE2",
  dotIdle: "#C2BAA9",
  anchorInk: "#3A352D",
  verified: "#5E8A5E",
};

// My pipeline roles → the gentle display vocabulary used across the UI.
export const ROLE_LABEL = {
  birthplace: "Hometown",
  ghetto: "Ghetto",
  camp: "Camp",
  transit: "Transit",
  liberation: "Liberation",
  resettlement: "New life",
};

// Places across the Atlantic are drawn as an off-map "new life" anchor, since the
// map frame is Europe (matches the reference; honest — the actual place is still named).
export const OVERSEAS = /canada|toronto|montreal|united states|u\.?s\.?a?\.?|new york|america/i;

export const TIME = { min: 1933, max: 1950 };

export const REDUCED_MOTION =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function initials(name) {
  const parts = String(name).replace(/\(sample\)/i, "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "·";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function parseYear(token) {
  if (token == null) return null;
  const m = String(token).match(/(1[89]\d\d|20\d\d)/);
  return m ? parseInt(m[1], 10) : null;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
