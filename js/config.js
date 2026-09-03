// Shared configuration: alpine twilight neutrals, one horizon-blue interface accent,
// and a quiet slate family for archive categories.

export const C = {
  paper: "#F1F3F5",
  paperSoft: "#FAFBFC",
  panel: "#FAFBFC",
  ink: "#18212A",
  inkSoft: "#34414C",
  muted: "#68737D",
  faint: "#87919A",
  line: "#D8DEE3",
  lineSoft: "#E6EAED",
  rule: "#CAD2D8",
  accent: "#3F6688",
  accentDeep: "#294B69",
  accentSoft: "#5A7893",
  accentWash: "#E7EDF2",
  land: "#D6DDE1",
  landStroke: "#C4CDD3",
  ocean: "#EDF0F2",
  globeOcean: "#C7D8E3",
  globeLand: "#8FA8BA",
  globeGrid: "#6F8CA2",
  densityNone: "#E9EDF0",
  densityLow: "#E1E7EB",
  dotIdle: "#A8B3BC",
  anchorInk: "#34414C",
  verified: "#3F6688",
};

// Group order follows the OHP archive. Muted, similarly weighted hues preserve equality.
export const GROUPS = [
  { name: "Holocaust Survivors", color: "#3F6688" },
  { name: "Military Veterans",   color: "#687D91" },
  { name: "Community Members",   color: "#6A7186" },
  { name: "First Nations",       color: "#8A7662" },
  { name: "Crestwood Families",  color: "#7C6E83" },
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

export const SYSTEM_REDUCED_MOTION =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

export function motionEnabled() {
  return true;
}

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
