// Shared map helpers: one Leaflet map instance, the quiet basemap, and small
// factory functions for the restrained markers and journey lines every mode reuses.
import { PALETTE, BASEMAP, REDUCED_MOTION, ROLE_LABELS } from "./config.js";

export function createMap(elementId) {
  const map = L.map(elementId, {
    zoomControl: true,
    minZoom: 3,
    maxZoom: 12,
    worldCopyJump: true,
    // Slow, deliberate motion only; instant when the visitor opts out (doc 01).
    zoomAnimation: !REDUCED_MOTION,
    fadeAnimation: !REDUCED_MOTION,
    markerZoomAnimation: !REDUCED_MOTION,
  });
  map.setView([50.5, 15.5], 5); // central Europe
  L.tileLayer(BASEMAP.url, BASEMAP.options).addTo(map);
  map.attributionControl.addAttribution(
    'Map: <a href="https://github.com/AlexDongzeyu/OHP-Map">Crestwood OHP Survivor Map</a>'
  );
  return map;
}

// A survivor's hometown dot. Keyboard-focusable with a screen-reader label so the
// map is navigable without a mouse (doc 02 N1).
export function survivorMarker(survivor, { active = false } = {}) {
  const home = survivor.waypoints.find((w) => w.role === "birthplace") || survivor.waypoints[0];
  const marker = L.marker([home.lat, home.lng], {
    keyboard: true,
    title: survivor.name,
    alt: `${survivor.name}, born in ${home.as_written}`,
    icon: dotIcon(active ? PALETTE.active : PALETTE.muted, active ? 10 : 7),
    riseOnHover: true,
  });
  marker._survivorId = survivor.survivor_id;
  return marker;
}

export function dotIcon(color, size) {
  return L.divIcon({
    className: "ohp-dot",
    html: `<span style="--c:${color};--s:${size}px"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

// A single survivor's journey as an ordered polyline through their waypoints.
export function journeyLine(survivor, color = PALETTE.journey) {
  const latlngs = survivor.waypoints.map((w) => [w.lat, w.lng]);
  return L.polyline(latlngs, {
    color,
    weight: 2.5,
    opacity: 0.85,
    lineJoin: "round",
    className: "ohp-journey",
  });
}

// Small waypoint markers along a journey, with role + as-written name in the label.
export function waypointMarkers(survivor, onClick) {
  return survivor.waypoints.map((wp, i) => {
    const m = L.marker([wp.lat, wp.lng], {
      keyboard: true,
      title: `${wp.as_written} — ${ROLE_LABELS[wp.role] || wp.role}`,
      alt: `${ROLE_LABELS[wp.role] || wp.role}: ${wp.as_written} (${wp.canonical})`,
      icon: dotIcon(wp.role === "birthplace" ? PALETTE.active : PALETTE.journey, 6),
    });
    m._waypoint = wp;
    m._order = i;
    if (onClick) m.on("click keypress", () => onClick(wp, survivor));
    return m;
  });
}

export function fitTo(map, layer, opts = {}) {
  try {
    const bounds = layer.getBounds ? layer.getBounds() : L.latLngBounds(layer);
    if (bounds.isValid())
      map.flyToBounds(bounds, {
        padding: [60, 60],
        animate: !REDUCED_MOTION,
        duration: REDUCED_MOTION ? 0 : 0.8,
        ...opts,
      });
  } catch (_) {
    /* ignore invalid bounds */
  }
}
