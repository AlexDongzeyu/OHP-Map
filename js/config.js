// Mineral paper, binding ink, and restrained catalogue colors.

export const C = {
  paper: "#F1F0EA",
  paperSoft: "#FAF9F5",
  panel: "#E9EBE4",
  ink: "#253638",
  inkSoft: "#455452",
  muted: "#626E68",
  faint: "#68736D",
  line: "#D5D9D0",
  lineSoft: "#E3E6DD",
  rule: "#C4CBC1",
  accent: "#496B64",
  accentDeep: "#2D504A",
  accentSoft: "#506E68",
  accentWash: "#E3EAE2",
  land: "#DADED4",
  landStroke: "#C1C9BE",
  ocean: "#ECEFE8",
  globeOcean: "#839E9D",
  globeLand: "#B9C8BE",
  globeGrid: "#516F71",
  densityNone: "#ECEFE8",
  densityLow: "#DFE5DC",
  dotIdle: "#A6B3A9",
  anchorInk: "#455452",
  verified: "#496B64",
  warCoalition: "#66849B",
  warOpposition: "#8A6563",
  warOccupied: "#948B94",
  warNeutral: "#DDE3E6",
  warBorder: "#B5C0C7",
};

// Group order follows the OHP archive. Muted, similarly weighted hues preserve equality.
export const GROUPS = [
  { name: "Holocaust Survivors", color: "#496B64" },
  { name: "Military Veterans",   color: "#576D7C" },
  { name: "Community Members",   color: "#686A7C" },
  { name: "First Nations",       color: "#7D6B53" },
  { name: "Crestwood Families",  color: "#786772" },
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

export const TIME = { min: 1914, max: 2026 };

const motionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const motionListeners = new Set();
export let SYSTEM_REDUCED_MOTION = Boolean(motionPreference?.matches);

const updateMotionPreference = (event) => {
  SYSTEM_REDUCED_MOTION = event.matches;
  for (const listener of motionListeners) listener(SYSTEM_REDUCED_MOTION);
};
if (motionPreference?.addEventListener) motionPreference.addEventListener("change", updateMotionPreference);
else motionPreference?.addListener?.(updateMotionPreference);

export function onMotionPreferenceChange(listener) {
  motionListeners.add(listener);
  return () => motionListeners.delete(listener);
}

export function motionEnabled() {
  return !SYSTEM_REDUCED_MOTION;
}

export function slug(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function normalizeSearch(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
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
