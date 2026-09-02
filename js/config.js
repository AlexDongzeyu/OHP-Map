// Shared configuration: mineral neutrals, one deep-pine interface accent, and a quiet
// alpine family for archive categories. Category color is data encoding, not hierarchy.

export const C = {
  paper: "#F4F6F3",
  paperSoft: "#FCFCFA",
  panel: "#FCFCFA",
  ink: "#171A18",
  inkSoft: "#303633",
  muted: "#5F6863",
  faint: "#7B847F",
  line: "#DCE2DD",
  lineSoft: "#E8ECE8",
  rule: "#CDD5CF",
  accent: "#315C4E",
  accentDeep: "#214237",
  accentSoft: "#43685C",
  accentWash: "#E9F0EC",
  land: "#DDE3DE",
  landStroke: "#C8D0CA",
  ocean: "#F1F3F0",
  densityNone: "#EDF0ED",
  densityLow: "#E8ECE8",
  dotIdle: "#AAB4AE",
  anchorInk: "#303633",
  verified: "#315C4E",
};

// Group order follows the OHP archive. Muted, similarly weighted hues preserve equality.
export const GROUPS = [
  { name: "Holocaust Survivors", color: "#315C4E" },
  { name: "Military Veterans",   color: "#657C72" },
  { name: "Community Members",   color: "#5F7580" },
  { name: "First Nations",       color: "#7E806A" },
  { name: "Crestwood Families",  color: "#756F7A" },
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
