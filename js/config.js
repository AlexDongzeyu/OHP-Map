// Shared configuration — the museum palette, role/group vocabulary, helpers.
// One ember accent over warm archival paper; everything else greyscale (doc 08/11).
// Group accents stay quiet and within the same warm family — equal treatment, not a
// rainbow hierarchy (doc 13 §4.3).

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

// Group order (how the OHP archive lists its categories) + a quiet accent per group.
// Hues stay close and muted so no group reads as "more important" than another.
export const GROUPS = [
  { name: "Holocaust Survivors", color: "#B45F2E" },
  { name: "Military Veterans",   color: "#6E7B53" },
  { name: "Community Members",   color: "#5E7382" },
  { name: "First Nations",       color: "#9A6A3F" },
  { name: "Crestwood Families",  color: "#7A6E86" },
];
export const GROUP_COLOR = Object.fromEntries(GROUPS.map((g) => [g.name, g.color]));

// My pipeline roles → the gentle display vocabulary used across the UI.
export const ROLE_LABEL = {
  birthplace: "Hometown",
  ghetto: "Ghetto",
  camp: "Camp",
  transit: "Transit",
  liberation: "Liberation",
  resettlement: "New life",
};

export const TIME = { min: 1914, max: 1955 };

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
