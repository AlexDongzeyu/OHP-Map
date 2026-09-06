import { accountLink } from "./research-tools.js";

export class ReferenceLinkError extends Error {}
export const isReferenceKey = value => typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);

function coordinateHex(value, limit) {
  if (!Number.isFinite(value) || Math.abs(value) > limit) {
    throw new ReferenceLinkError("This source reference has no stable mapped coordinates.");
  }
  const bytes = new ArrayBuffer(8);
  new DataView(bytes).setFloat64(0, value === 0 ? 0 : value, false);
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function sourceReferenceKey(account, waypoint) {
  if (!account || !waypoint || typeof account.survivor_id !== "string" ||
      !/^[a-z0-9-]+$/.test(account.survivor_id) || typeof account.archive_url !== "string" || !account.archive_url.trim() ||
      !["as_written", "canonical", "role"].every(key => typeof waypoint[key] === "string" && waypoint[key].trim())) {
    throw new ReferenceLinkError("The original source identity is incomplete.");
  }
  const date = waypoint.date;
  if (!date || !["start", "end", "precision"].every(key => Object.hasOwn(date, key)) ||
      Object.keys(date).some(key => !["start", "end", "precision", "as_written"].includes(key)) ||
      !["day", "month", "year", "range", "unknown"].includes(date.precision) ||
      Object.values(date).some(value => value !== null && typeof value !== "string")) {
    throw new ReferenceLinkError("This reference uses an unsupported source-date format.");
  }
  const optional = ["source_quote", "location_precision", "location_note", "location_source_url", "location_coordinate_source_url"];
  if (optional.some(key => waypoint[key] != null && typeof waypoint[key] !== "string")) {
    throw new ReferenceLinkError("This reference has unsupported source evidence.");
  }
  if (!globalThis.crypto?.subtle) throw new ReferenceLinkError("Reference links require a secure browser connection.");
  // This is the same source identity used by the offline human-review workflow.
  const payload = [
    "ohp-waypoint/v1", account.survivor_id, account.archive_url,
    waypoint.as_written, waypoint.canonical, waypoint.role,
    [date.start, date.end, date.precision, date.as_written ?? null],
    waypoint.source_quote ?? null,
    [coordinateHex(waypoint.lat, 90), coordinateHex(waypoint.lng, 180),
      ...optional.slice(1).map(key => waypoint[key] ?? null)],
  ];
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(payload)));
  return "sha256:" + [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function sourceReferenceTargets(account) {
  if (!account || typeof account !== "object") throw new ReferenceLinkError("The original source account is unavailable.");
  const entries = [];
  for (const collection of ["waypoints", "contextual_places"]) {
    const points = account?.[collection] || [];
    if (!Array.isArray(points)) throw new ReferenceLinkError("The original source references could not be read.");
    points.forEach((waypoint, index) => entries.push({ collection, index, waypoint }));
  }
  return Promise.all(entries.map(async entry => ({
    ...entry, key: await sourceReferenceKey(account, entry.waypoint),
  })));
}

export function referenceLink(journey, key, address) {
  if (!isReferenceKey(key)) throw new ReferenceLinkError("The selected reference link is invalid.");
  const url = new URL(accountLink(journey, address));
  url.searchParams.set("ref", key);
  return url.href;
}
