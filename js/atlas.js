// atlas.js — the map engine.
//
// Two stages share one SVG:
//   • a slow-rotating 3D globe (d3.geoOrthographic) for the LANDING — a clean
//     establishing shot of the whole world with faint origin points.
//   • a flat, paper-toned WORLD map (Canada · Europe · the Pacific · Korea) for
//     GUIDED / EXPLORE / DENSITY, with curved self-drawing journey arcs, an optional
//     origin-density CHOROPLETH, and FREE pan/zoom (d3.zoom).
//
// The 2D map is the canonical product; the globe is a calm overview with a graceful
// reduced-motion fallback. People are coloured quietly by archive group — equal, never
// a hierarchy (doc 13 §4.3).
import { C, GROUP_COLOR, motionEnabled, normalizeSearch, siteResource } from "./config.js";
import { flagFor, flagHistory, flagCatalogue, flagCatalogueMatch } from "./historical-context.js";
import { alignmentKey, datedTerritories } from "./historical-identity.js";

const d3 = window.d3;
const topojson = window.topojson;

export function createAtlas(container) {
  let world = null;
  let svg, globeG, camera, countriesG, historicalG, historicalLabelsG, historicalFlagsG, overlayG, comparisonRect, countrySel = null;
  let projection, path, gProjection, gPath;
  let size = { w: 0, h: 0 }, currentK = 1;
  let mapFrame = null;
  let selectedJourney = null;
  let selectedPlaceKey = null, activeClusterKey = null, collectionExtentKey = null;
  let mapContext = null;
  let selectedPatternEvent = null;
  let cameraTarget = null;
  let store = null, tipEl = null, zoom = null;
  let view = null, rotateRAF = null, rot = [-40, -32, 0];
  let globeRoutePool = [], globeRouteBatch = [], globeRouteCursor = 0;
  let globeRouteChangedAt = 0, globePhase = 0;
  let historicalFeatures = null, historicalPromise = null;
  let historicalStatus = "idle";
  let currentTerritoryPeriod = null;
  let currentBoundaryYear = null;
  let hoveredController = null, pinnedController = null;
  let controllerHandler = null;
  let historyDisplay = { compare: false, split: 50, opacity: 1 };
  let flagsVisible = true, labelsVisible = true;
  let activeFlagController = null;
  let visibleTerritories = [];
  let historicalPlacements = [];
  let uncertainTerritoryIds = new Set();
  const api = {};

  api.ready = (async function init() {
    world = await fetch(siteResource("data/atlas-world.json"), { cache: "force-cache" }).then((r) => {
      if (!r.ok) throw new Error(`World map failed to load: ${r.status}`);
      return r.json();
    });
    build();
    layout();
    return api;
  })();

  api.setStore = (s) => { store = s; if (projection) projectAll(); buildGlobeRoutePool(); };
  api.setTooltipEl = (el) => { tipEl = el; };

  function build() {
    container.innerHTML = "";
    if (!container.getAttribute("role") || container.getAttribute("role") === "img") container.setAttribute("role", "region");
    if (!container.getAttribute("aria-label")) container.setAttribute("aria-label", "Map of source place references");
    svg = d3.select(container).append("svg")
      .attr("width", "100%").attr("height", "100%").style("display", "block")
      .attr("role", "group").attr("tabindex", -1)
      .attr("aria-label", "Map of source place references");
    const occupiedPattern = svg.append("defs").append("pattern")
      .attr("id", "war-occupied")
      .attr("width", 7).attr("height", 7)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(35)");
    occupiedPattern.append("rect").attr("width", 7).attr("height", 7).attr("fill", C.warOccupied);
    occupiedPattern.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 7)
      .attr("stroke", C.paperSoft).attr("stroke-width", 2).attr("opacity", 0.38);
    comparisonRect = svg.select("defs").append("clipPath").attr("id", "history-comparison-clip")
      .attr("clipPathUnits", "userSpaceOnUse").append("rect");
    svg.append("rect").attr("class", "atlas-bg")
      .attr("width", "100%").attr("height", "100%").attr("fill", C.ocean);
    globeG = svg.append("g").attr("class", "globe").style("display", "none");
    camera = svg.append("g").attr("class", "camera").style("transform-origin", "0 0");
    countriesG = camera.append("g").attr("class", "modern-countries");
    historicalG = camera.append("g").attr("class", "historical-territories").style("display", "none");
    historicalLabelsG = camera.append("g").attr("class", "historical-labels")
      .style("display", "none").style("pointer-events", "none");
    historicalFlagsG = camera.append("g").attr("class", "historical-flags").style("display", "none");
    overlayG = camera.append("g").attr("class", "map-references");
    bindReferenceControls();

    const interruptCamera = () => svg.interrupt().interrupt("camera");
    zoom = d3.zoom().scaleExtent([1, 14])
      .on("start", (ev) => {
        if (ev.sourceEvent) {
          interruptCamera();
          if (api.onUserCameraChange) api.onUserCameraChange();
        }
      })
      .on("zoom", (ev) => { currentK = ev.transform.k; camera.attr("transform", ev.transform.toString()); rescale(); })
      .on("end", () => {
        if (view === "patterns" && currentBoundaryYear != null) {
          const labelled = renderHistoricalFlags(visibleTerritories, currentBoundaryYear);
          renderHistoricalLabels(visibleTerritories, labelled);
        }
        if (view === "patterns" && api.onCameraSettled) api.onCameraSettled();
      });
    svg.call(zoom)
      .on("dblclick.zoom", null)
      .on("wheel.camera-interrupt", interruptCamera, { capture: true, passive: true })
      .on("pointerdown.camera-interrupt", interruptCamera, { capture: true })
      .on("wheel", (e) => e.preventDefault())
      .on("focusin.map", (event) => {
        const marker = event.target.closest("[data-map-focus]");
        if (marker) focusReference(marker);
      })
      .on("focusout.map", (event) => {
        if (!event.relatedTarget?.closest?.("[data-map-focus]")) hideTip();
      });
  }

  function rescale() {
    overlayG.selectAll("[data-r]").attr("r", function () { return +this.getAttribute("data-r") / currentK; });
    camera.selectAll("[data-fs]").attr("font-size", function () { return (+this.getAttribute("data-fs") / currentK) + "px"; });
    overlayG.selectAll("[data-y0]").attr("y", function () {
      return +this.getAttribute("data-y0") - (+this.getAttribute("data-dy")) / currentK;
    });
    historicalFlagsG.selectAll(".historical-flag")
      .attr("transform", (datum) => `translate(${datum.x},${datum.y}) scale(${1 / currentK})`);
    layoutCollectionReferences();
    applyHistoryDisplay();
    const focused = container.contains(document.activeElement) && document.activeElement.closest("[data-map-focus]");
    if (focused && tipEl?.style.opacity === "1") showReferenceTip(focused);
  }

  function applyHistoryDisplay() {
    if (!svg || !mapFrame) return;
    const transform = d3.zoomTransform(svg.node());
    const divider = mapFrame[0] + (mapFrame[2] - mapFrame[0]) * historyDisplay.split / 100;
    comparisonRect.attr("x", transform.invertX(0)).attr("y", transform.invertY(0))
      .attr("width", divider / transform.k).attr("height", size.h / transform.k);
    const comparing = historyDisplay.compare && historicalStatus === "ready" && currentBoundaryYear != null;
    const clip = comparing ? "url(#history-comparison-clip)" : null;
    historicalG.attr("clip-path", clip).style("opacity", historyDisplay.opacity);
    historicalLabelsG.attr("clip-path", clip);
    historicalFlagsG.attr("clip-path", clip);
    container.dataset.comparing = String(comparing);
    container.style.setProperty("--comparison-x", `${divider}px`);
    container.style.setProperty("--comparison-top", `${mapFrame[1]}px`);
    container.style.setProperty("--comparison-height", `${mapFrame[3] - mapFrame[1]}px`);
  }
  api.setHistoryDisplay = (settings) => {
    if (!Number.isFinite(settings.split) || !Number.isFinite(settings.opacity)) {
      console.warn("Map comparison values must be numeric.");
      return;
    }
    historyDisplay = {
      compare: Boolean(settings.compare),
      split: Math.max(0, Math.min(100, settings.split)),
      opacity: Math.max(.2, Math.min(1, settings.opacity)),
    };
    applyHistoryDisplay();
    if (view === "patterns" && currentBoundaryYear != null && historicalFeatures) {
      const flagged = renderHistoricalFlags(visibleTerritories, currentBoundaryYear);
      renderHistoricalLabels(visibleTerritories, flagged);
    }
  };
  api.historyLoaded = () => Boolean(historicalFeatures);
  api.historyState = () => historicalStatus;
  api.retryHistory = () => {
    if (historicalStatus !== "error") return historicalPromise;
    historicalStatus = "idle";
    return ensureHistoricalBoundaries(true);
  };

  function activeTerritories(year) {
    return datedTerritories(historicalFeatures || [], year);
  }
  function uncertainRecords(year) {
    const quality = store?.historicalIndex?.quality;
    if (quality?.input_sha256 !== store?.historicalIndex?.geometry_sha256) return new Set();
    return new Set(quality.years.find((entry) => entry.year === year)?.alternative_record_ids || []);
  }
  function administrationLabel(controller, features) {
    return controller === "Russia" && features.some((feature) => (
      feature.properties.controller === "Russia" && feature.properties.name === "Soviet Union"
    )) ? "Soviet Union" : controller;
  }
  api.searchLocations = (query, year) => {
    const locations = new Map();
    const features = activeTerritories(year);
    for (const feature of features) {
      const controller = feature.properties.controller || feature.properties.name;
      const name = administrationLabel(controller, features);
      if (name) locations.set(`country:${controller}`, { name, controller, matchName: alignmentKey(controller), kind: "country" });
    }
    for (const journey of store?.journeys || []) {
      for (const place of journey.waypoints) {
        if (place.canonical && Number.isFinite(place.lng) && Number.isFinite(place.lat)) {
          locations.set(`place:${place.canonical}`, { name: place.canonical, kind: "place", lng: place.lng, lat: place.lat });
        }
      }
    }
    const aliases = { uk: "united kingdom", usa: "united states", us: "united states", ussr: "soviet union" };
    const term = aliases[normalizeSearch(query)] || normalizeSearch(query);
    return [...locations.values()]
      .filter((entry) => !term || [entry.name, entry.controller, entry.matchName].some((name) => normalizeSearch(name).includes(term)))
      .map((entry) => ({ ...entry, exact: Boolean(term) && [entry.name, entry.controller, entry.matchName].some((name) => normalizeSearch(name) === term) }))
      .sort((a, b) => Number(b.exact) - Number(a.exact) ||
        Number(b.kind === "country") - Number(a.kind === "country") || a.name.localeCompare(b.name));
  };
  api.countryInfo = (name, year) => {
    const active = activeTerritories(year);
    const controllers = [...new Set(active.map((feature) => feature.properties.controller || feature.properties.name))];
    const aliases = controllers.filter((controller) => alignmentKey(controller) === name);
    const controller = controllers.includes(name) ? name : (
      aliases.length === 1 ? aliases[0] : (
        name === "Soviet Union" && administrationLabel("Russia", active) === name ? "Russia" : name
      )
    );
    const features = active.filter((feature) => (
      (feature.properties.controller || feature.properties.name) === controller
    ));
    if (!features.length) return null;
    const territories = [...new Map(features.map((feature) => [
      `${feature.properties.name}|${territoryYears(feature)}`,
      { name: feature.properties.name, dates: territoryYears(feature), kind: feature.properties.kind },
    ])).values()].sort((a, b) => a.name.localeCompare(b.name));
    const largest = [...features].sort((a, b) => (b.properties.area_km2 || 0) - (a.properties.area_km2 || 0))[0];
    const [lng, lat] = d3.geoCentroid(largest);
    const referencePosition = Number.isFinite(lng) && Number.isFinite(lat)
      ? `position=3/${lat.toFixed(4)}/${lng.toFixed(4)}&` : "";
    return {
      name: administrationLabel(controller, active), controller,
      count: territories.length, territories, flag: flagFor(administrationLabel(controller, active), year),
      flagHistory: flagHistory(administrationLabel(controller, active)),
      inferredGrouping: features.some((feature) => feature.properties.controller_basis === "name_grouping"),
      alternativeRecords: features.filter((feature) => uncertainRecords(year).has(feature.properties.id)).length,
      externalUrl: `https://www.oldmapsonline.org/en/history/regions#${referencePosition}year=${year}`,
    };
  };
  api.flagCountries = (year) => {
    const entries = flagCatalogue(year);
    for (const country of api.searchLocations("", year).filter(entry => entry.kind === "country")) {
      const existing = flagCatalogueMatch(entries, country.name, year);
      if (existing) {
        if (!existing.controller || existing.name === country.name) existing.controller = country.controller;
      } else entries.push({
        name: country.name, names: [country.name, country.controller, country.matchName].filter(Boolean),
        controller: country.controller, flag: flagFor(country.name, year), history: flagHistory(country.name),
      });
    }
    return entries.sort((a, b) => a.name.localeCompare(b.name));
  };
  api.cameraPosition = () => {
    if (!projection || !mapFrame) return null;
    const transform = d3.zoomTransform(svg.node());
    const center = [(mapFrame[0] + mapFrame[2]) / 2, (mapFrame[1] + mapFrame[3]) / 2];
    const position = projection.invert(transform.invert(center));
    if (!position?.every(Number.isFinite) || Math.abs(position[1]) > 90) return null;
    return { lng: ((position[0] + 180) % 360 + 360) % 360 - 180, lat: position[1], zoom: transform.k };
  };
  api.focusCoordinates = (lng, lat, scale = 4, animate = motionEnabled()) => {
    const point = projection([lng, lat]);
    if (!point?.every(Number.isFinite)) {
      console.warn("The requested map location could not be projected.");
      return;
    }
    moveCamera({ x: point[0], y: point[1] }, scale, animate);
  };
  function focusController(name, year) {
    const features = activeTerritories(year).filter((feature) => (
      (feature.properties.controller || feature.properties.name) === name
    ));
    if (!features.length) return;
    const [[x0, y0], [x1, y1]] = path.bounds({ type: "FeatureCollection", features });
    if (![x0, y0, x1, y1].every(Number.isFinite)) {
      console.warn("This administration has no projectable boundary geometry.");
      return;
    }
    const padding = Math.min(40, (mapFrame[3] - mapFrame[1]) * .2);
    const scale = Math.min(7, Math.max(1, Math.min(
      (mapFrame[2] - mapFrame[0] - padding) / Math.max(1, x1 - x0),
      (mapFrame[3] - mapFrame[1] - padding) / Math.max(1, y1 - y0),
    )));
    moveCamera({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, scale);
  }

  function availableMapFrame() {
    const { w, h } = size;
    const mobile = w <= 820;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 72;
    let left = 20, right = w - 20, top = header + 20, bottom = h - 24;
    const bounds = (selector) => {
      const element = document.querySelector(selector);
      if (!element?.getClientRects().length || (mobile && selector === ".rail" && element.closest(".has-sel"))) return null;
      let x = 0, y = 0;
      for (let parent = element; parent && parent !== container.parentElement; parent = parent.offsetParent) {
        x += parent.offsetLeft;
        y += parent.offsetTop;
      }
      return { left: x, top: y, right: x + element.offsetWidth, bottom: y + element.offsetHeight };
    };
    if (view === "explore" && document.querySelector(".ov-explore")?.dataset.presentation !== "reader") {
      const sheet = bounds(".rail");
      const profile = bounds(".panel-host:has(.panel)");
      const caption = bounds(".explore-map-status");
      if (mobile) {
        top = header + (profile ? 68 : 84);
        if (profile || sheet) bottom = (profile || sheet).top - 16;
      } else {
        if (sheet) left = sheet.right + 24;
        if (profile) right = profile.left - 24;
      }
      if (caption) top = Math.max(top, caption.bottom + 12);
      const readerReturn = bounds(".reader-return");
      if (readerReturn) bottom = Math.min(bottom, readerReturn.top - 16);
    } else if (view === "patterns") {
      const origins = bounds(".patterns-intro");
      const heading = bounds(".patterns-map-head");
      const dossier = bounds(".history-dossier");
      const timeline = bounds(".scrubber");
      if (origins) {
        if (mobile) { bottom = origins.top - 16; top = header + 68; }
        else left = origins.right + 24;
      } else {
        if (heading) top = heading.bottom + 16;
        if (timeline) bottom = timeline.top - 20;
        if (dossier) {
          if (mobile) bottom = dossier.top - 16;
          else right = dossier.left - 24;
        }
      }
    }
    top = Math.min(top, bottom - 48);
    return [left, top, Math.max(left + 80, right), bottom];
  }

  // Fit the world to the exposed map, not the area covered by a reading panel.
  function layout(redraw) {
    if (!container) return false;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return false;
    const sameSize = size.w === w && size.h === h;
    size = { w, h };
    const frame = availableMapFrame();
    if (redraw && projection && sameSize && mapFrame && frame.every((value, index) => value === mapFrame[index])) return false;
    mapFrame = frame;
    projection = d3.geoEqualEarth().scale(1).translate([0, 0]);
    const [[west], [east]] = d3.geoPath(projection).bounds({ type: "Sphere" });
    const north = projection([0, 90])[1], south = projection([0, -60])[1];
    const scale = Math.min((mapFrame[2] - mapFrame[0]) / (east - west), (mapFrame[3] - mapFrame[1]) / (south - north));
    const x = (mapFrame[0] + mapFrame[2] - scale * (west + east)) / 2;
    const y = (mapFrame[1] + mapFrame[3] - scale * (north + south)) / 2;
    // Equal Earth's parallels are horizontal. Clip only streamed display geometry;
    // source features, IDs and point coordinates (including southern references) stay intact.
    projection.scale(scale).translate([x, y])
      .clipExtent([[x + scale * west - 1, y + scale * north - 1], [x + scale * east + 1, y + scale * south]]);
    path = d3.geoPath(projection);

    const land = countriesG.selectAll("path").data(world.features);
    countrySel = land.enter().append("path").merge(land)
      .attr("d", path).attr("data-country", (d) => d.properties.name).attr("fill", C.land)
      .attr("stroke", C.landStroke).attr("stroke-width", 0.5)
      .attr("vector-effect", "non-scaling-stroke");
    land.exit().remove();

    layoutGlobe();
    if (store) projectAll();
    if (redraw && api._last) {
      svg.interrupt("camera").call(zoom.transform, d3.zoomIdentity);
      api._last(true);
    }
    return true;
  }
  api.resize = () => {
    const position = view === "patterns" ? api.cameraPosition() : null;
    const changed = layout(true);
    if (position && changed) api.focusCoordinates(position.lng, position.lat, position.zoom, false);
  };

  function layoutGlobe() {
    const { w, h } = size;
    const mobile = w <= 820;
    const r = Math.min(w, h) * (mobile ? 0.34 : 0.36);
    const headerHeight = parseFloat(
      getComputedStyle(document.documentElement).getPropertyValue("--header-height"),
    ) || 68;
    const contentCenterY = headerHeight + (h - headerHeight) * (mobile ? .2 : .5);
    gProjection = d3.geoOrthographic().scale(r)
      .translate([w * (mobile ? .7 : .72), contentCenterY]).rotate(rot).clipAngle(90);
    gPath = d3.geoPath(gProjection);
  }

  function projectAll() {
    for (const journey of store.journeys) projectJourney(journey);
  }

  function projectJourney(journey) {
    const places = new Set([
      ...(journey.waypoints || []), ...(journey.contextualPlaces || []),
      ...(journey.routeWaypoints || []), journey.routeStart, journey.birthplace,
    ]);
    for (const point of places) {
      if (!point) continue;
      const projected = hasCoordinates(point) ? projection([point.lng, point.lat]) : null;
      point.px = projected?.every(Number.isFinite) ? projected[0] : null;
      point.py = projected?.every(Number.isFinite) ? projected[1] : null;
    }
  }

  // Hydration can replace every place object. Project it without rendering or
  // moving the camera; optionally refresh a supplied mini-map SVG as well.
  api.refreshJourney = (journey, { miniEl } = {}) => {
    if (!journey || !projection) return false;
    projectJourney(journey);
    if (miniEl) api.drawMini(miniEl, journey);
    return true;
  };

  function hasCoordinates(point) {
    return Number.isFinite(point.lng) && Number.isFinite(point.lat);
  }
  function hasMapPoint(point) {
    return hasCoordinates(point) && Number.isFinite(point.px) && Number.isFinite(point.py);
  }
  function personalPrecise(point) {
    return (point.evidenceScope === "personal" || point.verified) && ["city", "site"].includes(point.locationPrecision);
  }
  function mappedPoints(journey) {
    return (journey.waypoints || []).filter(hasMapPoint);
  }
  function routePoints(journey) {
    return (journey.routeWaypoints || []).filter((point) => hasMapPoint(point) && personalPrecise(point));
  }

  function legPath(a, b) {
    const dx = b.px - a.px, dy = b.py - a.py;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = Math.min(len * 0.14, 90);
    const cx = (a.px + b.px) / 2 + nx * off, cy = (a.py + b.py) / 2 + ny * off;
    return `M${a.px},${a.py} Q${cx},${cy} ${b.px},${b.py}`;
  }

  const journeyLine = d3.line()
    .x((point) => point.px ?? point.x)
    .y((point) => point.py ?? point.y)
    .curve(d3.curveCatmullRom.alpha(0.5));

  function journeyPath(points) {
    const distinct = points.filter((point, index) => {
      if (!index) return true;
      const previous = points[index - 1];
      return (point.px ?? point.x) !== (previous.px ?? previous.x) ||
        (point.py ?? point.y) !== (previous.py ?? previous.y);
    });
    return distinct.length > 1 ? journeyLine(distinct) : null;
  }

  api.pointAtYear = function (j, year) {
    const wps = j.waypoints.filter((w) => w.year != null && w.px != null);
    if (!wps.length) return null;
    if (year <= wps[0].year) return { x: wps[0].px, y: wps[0].py, before: true };
    const last = wps[wps.length - 1];
    if (year >= last.year) return { x: last.px, y: last.py, after: true };
    for (let i = 0; i < wps.length - 1; i++) {
      const a = wps[i], b = wps[i + 1];
      if (year >= a.year && year <= b.year) {
        const t = b.year === a.year ? 1 : (year - a.year) / (b.year - a.year);
        return { x: a.px + (b.px - a.px) * t, y: a.py + (b.py - a.py) * t, glow: a.approx || b.approx };
      }
    }
    return { x: last.px, y: last.py };
  };

  // ---- draw primitives -------------------------------------------------------
  function clearOverlay() {
    hideTip();
    overlayG.selectAll("*").interrupt().remove();
  }
  function dot(g, x, y, o = {}) {
    const r = o.r || 4;
    return g.append("circle").attr("cx", x).attr("cy", y).attr("data-r", r).attr("r", r / currentK)
      .attr("fill", o.fill || C.dotIdle).attr("stroke", o.stroke || "none")
      .attr("stroke-width", o.sw || 0).attr("vector-effect", "non-scaling-stroke")
      .attr("opacity", o.op == null ? 1 : o.op);
  }
  function route(g, points, o = {}) {
    const d = journeyPath(points);
    if (!d) return null;
    const p = g.append("path").attr("d", d).attr("fill", "none")
      .attr("class", o.className || null)
      .attr("stroke", o.color || C.accent).attr("stroke-width", o.width || 2)
      .attr("vector-effect", "non-scaling-stroke")
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
      .attr("opacity", o.op == null ? 1 : o.op);
    if (o.animate && motionEnabled()) {
      const len = p.node().getTotalLength();
      p.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
        .transition().duration(900).ease(d3.easeCubicInOut).attr("stroke-dashoffset", 0);
    }
    return p;
  }
  function label(g, x, y, text, o = {}) {
    const fs = o.fs || 11, dy = o.dy || 0;
    return g.append("text").attr("x", x).attr("data-y0", y).attr("data-dy", dy).attr("y", y - dy / currentK)
      .attr("text-anchor", "middle").attr("data-fs", fs).attr("font-size", `${fs / currentK}px`)
      .attr("font-family", "'Public Sans',sans-serif").attr("font-weight", o.weight || 600)
      .attr("letter-spacing", o.ls || "0").attr("fill", o.fill || C.anchorInk)
      .attr("paint-order", o.halo ? "stroke" : null)
      .attr("stroke", o.halo ? C.paperSoft : null)
      .attr("stroke-width", o.halo ? 3 : null)
      .attr("stroke-linejoin", o.halo ? "round" : null)
      .attr("vector-effect", "non-scaling-stroke").text(text);
  }

  function moveCamera(target, k, animate = motionEnabled()) {
    const centerX = (mapFrame[0] + mapFrame[2]) / 2;
    const centerY = (mapFrame[1] + mapFrame[3]) / 2;
    const t = target
      ? d3.zoomIdentity.translate(centerX - k * target.x, centerY - k * target.y).scale(k)
      : d3.zoomIdentity;
    applyCameraTransform(t, 850, d3.easeCubicInOut, animate);
  }
  function applyCameraTransform(transform, duration, ease, animate = motionEnabled()) {
    svg.interrupt("camera");
    cameraTarget = animate ? transform : null;
    const selection = animate ? svg.transition("camera").duration(duration).ease(ease)
      .on("end.motion interrupt.motion", () => { cameraTarget = null; }) : svg;
    selection.call(zoom.transform, transform);
  }
  api.resetCamera = () => {
    if (view === "explore" && store) {
      const journey = store.byId.get(mapContext?.selectedId);
      fitReferences(journey ? mappedPoints(journey) : collectionClusters(mapContext?.matches));
    } else moveCamera(null, 1);
  };
  function fitReferences(points) {
    if (!points.length) { moveCamera(null, 1); return; }
    const xs = points.map((point) => point.px), ys = points.map((point) => point.py);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const width = mapFrame[2] - mapFrame[0], height = mapFrame[3] - mapFrame[1];
    const padX = Math.min(42, width * .12), padY = Math.min(38, height * .16);
    const single = Math.hypot(x1 - x0, y1 - y0) < 1e-6;
    const precise = points.every((point) => ["city", "site"].includes(point.locationPrecision));
    const scale = Math.min(single ? 6 : precise ? 14 : 8, Math.max(1, Math.min(
      (width - padX * 2) / Math.max(1e-6, x1 - x0),
      (height - padY * 2) / Math.max(1e-6, y1 - y0),
    )));
    moveCamera({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, scale);
  }
  function focusJourney(journey) {
    fitReferences(mappedPoints(journey));
  }
  api.zoomBy = (factor) => {
    if (!Number.isFinite(factor) || factor <= 0) {
      console.warn("The map zoom factor must be a positive number.");
      return;
    }
    const center = [(mapFrame[0] + mapFrame[2]) / 2, (mapFrame[1] + mapFrame[3]) / 2];
    const current = d3.zoomTransform(svg.node());
    const point = current.invert(center);
    const scale = Math.max(1, Math.min(14, current.k * factor));
    const target = d3.zoomIdentity.translate(center[0] - scale * point[0], center[1] - scale * point[1]).scale(scale);
    applyCameraTransform(target, 280, d3.easeCubicOut);
  };

  api.syncMotion = () => {
    if (!svg) return;
    if (!motionEnabled()) {
      const target = cameraTarget;
      svg.interrupt("camera");
      if (target) svg.call(zoom.transform, target);
      overlayG.selectAll("[stroke-dashoffset]").interrupt().attr("stroke-dashoffset", 0);
    }
    if (view === "landing" && !document.hidden) startRotate();
    else stopRotate();
  };

  function showTip(e, text) { if (!tipEl) return; tipEl.textContent = text; tipEl.style.opacity = 1; moveTip(e); }
  function moveTip(e) {
    if (!tipEl) return;
    const r = container.getBoundingClientRect();
    tipEl.style.left = (e.clientX - r.left) + "px"; tipEl.style.top = (e.clientY - r.top) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = 0; }

  function referenceControl(target) {
    const marker = target.closest?.(".account-place-marker, .place-cluster");
    return marker && overlayG.node().contains(marker) ? marker : null;
  }
  function activateReference(marker) {
    if (marker.classList.contains("place-cluster")) mapContext?.onPlaceCluster?.(marker.__data__.canonical);
    else mapContext?.onPlace?.(Number(marker.dataset.placeIndex));
  }
  function bindReferenceControls() {
    overlayG
      .on("click.references", (event) => {
        const marker = referenceControl(event.target);
        if (!marker) return;
        event.stopPropagation();
        marker.focus({ preventScroll: true });
        activateReference(marker);
      })
      .on("keydown.references", (event) => {
        const marker = referenceControl(event.target);
        if (!marker) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          event.stopPropagation();
          activateReference(marker);
          return;
        }
        if (!marker.classList.contains("place-cluster")) return;
        browseMapMarkers(event, marker, overlayG.selectAll(".place-cluster").nodes());
      })
      .on("pointerover.references", (event) => {
        const marker = referenceControl(event.target);
        if (marker && !marker.contains(event.relatedTarget)) showTip(event, marker.getAttribute("aria-label"));
      })
      .on("pointermove.references", (event) => {
        if (referenceControl(event.target)) moveTip(event);
      })
      .on("pointerout.references", (event) => {
        const marker = referenceControl(event.target);
        if (!marker || marker.contains(event.relatedTarget)) return;
        const focused = container.contains(document.activeElement) && document.activeElement.closest("[data-map-focus]");
        if (focused) showReferenceTip(focused);
        else hideTip();
      });
  }
  function browseMapMarkers(event, marker, markers) {
    const steps = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
    if (!(event.key in steps) && !["Home", "End"].includes(event.key)) return;
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    const index = markers.indexOf(marker);
    const next = event.key === "Home" ? 0 : event.key === "End" ? markers.length - 1 :
      (index + steps[event.key] + markers.length) % markers.length;
    markers[next]?.focus({ preventScroll: true });
  }
  function showReferenceTip(marker) {
    const rect = marker.getBoundingClientRect();
    showTip({ clientX: (rect.left + rect.right) / 2, clientY: rect.top }, marker.getAttribute("aria-label"));
  }
  function keepReferenceVisible(marker) {
    if (!mapFrame || view === "landing") return;
    const rect = marker.getBoundingClientRect(), bounds = container.getBoundingClientRect();
    const x = (rect.left + rect.right) / 2 - bounds.left, y = (rect.top + rect.bottom) / 2 - bounds.top;
    const point = d3.zoomTransform(svg.node()).invert([x, y]);
    const [targetX, targetY] = cameraTarget ? cameraTarget.apply(point) : [x, y];
    const pad = 18;
    if (targetX < mapFrame[0] + pad || targetX > mapFrame[2] - pad || targetY < mapFrame[1] + pad || targetY > mapFrame[3] - pad) {
      moveCamera({ x: point[0], y: point[1] }, currentK, false);
    }
  }
  function focusReference(marker) {
    if (marker.classList.contains("place-cluster")) {
      activeClusterKey = marker.__data__.key;
      overlayG.selectAll(".place-cluster[tabindex='0']").attr("tabindex", -1);
      d3.select(marker).attr("tabindex", 0);
      layoutCollectionReferences();
    } else if (marker.classList.contains("historical-flag")) {
      activeFlagController = marker.__data__.controller;
      historicalFlagsG.selectAll(".historical-flag").attr("tabindex", -1);
      d3.select(marker).attr("tabindex", 0);
    }
    keepReferenceVisible(marker);
    showReferenceTip(marker);
    mapContext?.onMapFocus?.(marker.getAttribute("aria-label"));
  }
  api.focusMap = () => {
    if (!svg || container.closest("[inert]") || !container.getClientRects().length || getComputedStyle(container).visibility === "hidden") {
      console.warn("Cannot focus the map: its region is not currently visible or interactive.");
      return false;
    }
    const selected = overlayG.select(".account-place-marker[aria-pressed='true']").node();
    const candidates = [
      selected, overlayG.select(".account-place-marker").node(),
      overlayG.select(".place-cluster[tabindex='0']").node(),
      overlayG.select(".pattern-event-marker[aria-pressed='true']").node(),
      ...svg.selectAll(".place-cluster, .pattern-event-marker, .historical-flag").nodes(),
    ];
    const target = candidates.find((node) => node?.getClientRects().length) || svg.node();
    if (target !== svg.node()) keepReferenceVisible(target);
    const alreadyFocused = document.activeElement === target;
    target.focus({ preventScroll: true });
    if (document.activeElement !== target) {
      console.warn("Cannot focus the map: no available map target accepted focus.");
      return false;
    }
    if (target === svg.node()) mapContext?.onMapFocus?.("Map region. No place controls are available in this view.");
    else if (alreadyFocused) focusReference(target);
    return true;
  };

  // ---- choropleth ------------------------------------------------------------
  function paintChoropleth(on, onOrigin) {
    if (!countrySel) return;
    countrySel.interrupt("country-fill")
      .on(".war", null)
      .on(".origin", null)
      .style("pointer-events", null)
      .style("cursor", null)
      .attr("data-origin-count", null)
      .attr("data-war-side", null)
      .attr("stroke", C.landStroke)
      .attr("stroke-width", 0.5);
    if (!on) { countrySel.attr("fill", C.land); return; }
    const max = Math.max(1, ...[...store.originCounts.values()]);
    const ramp = d3.interpolateRgb(C.densityLow, C.accentDeep);
    countrySel.attr("fill", (d) => {
      const n = store.originCounts.get(d.properties.name) || 0;
      return n ? ramp(.25 + .75 * Math.sqrt(n / max)) : C.densityNone;
    })
      .attr("data-origin-count", (d) => store.originCounts.get(d.properties.name) || 0)
      .style("cursor", (d) => store.originCounts.has(d.properties.name) ? "pointer" : null)
      .on("click.origin", (event, d) => {
        if (store.originCounts.has(d.properties.name)) onOrigin(d.properties.name);
      })
      .on("mouseenter.origin", (event, d) => {
        const count = store.originCounts.get(d.properties.name);
        if (count) showTip(event, `${d.properties.name}: ${count} mapped starting references. Select to read the accounts.`);
      })
      .on("mousemove.origin", moveTip)
      .on("mouseleave.origin", hideTip);
  }

  function paintWarContext(period) {
    if (!countrySel || !period) { paintChoropleth(false); return; }
    const coalition = new Set(period.coalition || []);
    const opposition = new Set(period.opposition || []);
    const occupied = new Set(period.occupied || []);
    const statusFor = (name) => {
      if (occupied.has(name)) return "occupied";
      if (coalition.has(name)) return "coalition";
      if (opposition.has(name)) return "opposition";
      return "neutral";
    };
    const fillFor = (status) => ({
      coalition: C.warCoalition,
      opposition: C.warOpposition,
      occupied: "url(#war-occupied)",
      neutral: C.warNeutral,
    }[status]);
    countrySel.interrupt("country-fill")
      .attr("fill", (d) => fillFor(statusFor(d.properties.name)))
      .attr("stroke", C.warBorder)
      .attr("stroke-width", 0.6)
      .attr("data-war-side", (d) => statusFor(d.properties.name))
      .style("pointer-events", (d) => statusFor(d.properties.name) === "neutral" ? "none" : "all")
      .on("mouseenter.war", (event, d) => {
        const name = d.properties.name;
        const status = statusFor(name);
        const aligned = coalition.has(name)
          ? period.coalition_label
          : (opposition.has(name) ? period.opposition_label : null);
        const detail = status === "occupied"
          ? [aligned, "occupied or contested"].filter(Boolean).join(", ")
          : aligned;
        showTip(event, `${name}. ${detail || period.conflict}`);
      })
      .on("mousemove.war", (event) => moveTip(event))
      .on("mouseleave.war", hideTip);
  }

  function ensureHistoricalBoundaries(retry = false) {
    if (historicalFeatures || historicalStatus === "loading" || historicalStatus === "error") return historicalPromise;
    historicalStatus = "loading";
    document.documentElement.dataset.historicalBoundaries = "loading";
    api.onHistoryStatus?.();
    const revision = store?.historicalIndex?.geometry_revision || "legacy";
    historicalPromise = fetch(siteResource(`data/historical_boundaries.json?v=${encodeURIComponent(revision)}`), { cache: retry ? "reload" : "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Historical boundaries failed to load: ${response.status}`);
        return response.json();
      })
      .then((topology) => {
        if (!topojson?.feature || !topology.objects?.territories) {
          throw new Error("Historical boundary topology is invalid or TopoJSON is unavailable");
        }
        const features = topojson.feature(topology, topology.objects.territories).features;
        if (!Array.isArray(features) || !features.length) throw new Error("Historical boundaries contain no territory records");
        return features;
      })
      .then((features) => {
        historicalFeatures = features;
        historicalStatus = "ready";
        document.documentElement.dataset.historicalBoundaries = "ready";
        api.onHistoryStatus?.();
        if (api._last) api._last(true);
        if (api.onHistoryReady) api.onHistoryReady();
        return historicalFeatures;
      }, (error) => {
        historicalStatus = "error";
        document.documentElement.dataset.historicalBoundaries = "error";
        console.error(error);
        api.onHistoryStatus?.();
        return null;
      })
      .finally(() => { historicalPromise = null; });
    return historicalPromise;
  }

  function territoryStatus(feature, period) {
    if (!period) return "neutral";
    const { name, kind } = feature.properties;
    const controller = alignmentKey(feature.properties.controller);
    if ((period.occupied || []).includes(controller) || (period.occupied || []).includes(name)) {
      return "occupied";
    }
    if (kind === "occupation") return "occupied";
    if ((period.coalition || []).includes(controller)) return "coalition";
    if ((period.opposition || []).includes(controller)) return "opposition";
    return "neutral";
  }

  function territoryFill(feature, period) {
    const status = territoryStatus(feature, period);
    if (status === "coalition") return C.warCoalition;
    if (status === "opposition") return C.warOpposition;
    if (status === "occupied") return "url(#war-occupied)";
    const token = String(feature.properties.controller || feature.properties.name);
    let hash = 0;
    for (let index = 0; index < token.length; index++) hash = ((hash << 5) - hash + token.charCodeAt(index)) | 0;
    return ["#D6DEE3", "#CFD9DF", "#DCE3E6", "#C8D4DB"][Math.abs(hash) % 4];
  }

  function territoryYears(feature) {
    const start = Math.max(1, Math.floor(feature.properties.start));
    const end = feature.properties.end == null ? "present" : Math.max(start, Math.ceil(feature.properties.end) - 1);
    return `${start} to ${end}`;
  }

  function territoryDescription(feature) {
    const { name, controller, kind } = feature.properties;
    const control = controller && controller !== name
      ? `, ${feature.properties.controller_basis === "name_grouping" ? "grouped from the name under" : "grouped under"} ${controller}`
      : "";
    const type = kind ? `, ${String(kind).replaceAll("_", " ")}` : "";
    const status = territoryStatus(feature, currentTerritoryPeriod);
    const alignment = status === "coalition"
      ? currentTerritoryPeriod?.coalition_label
      : (status === "opposition"
        ? currentTerritoryPeriod?.opposition_label
        : (status === "occupied" ? "occupied / contested" : null));
    const uncertainty = uncertainTerritoryIds.has(feature.properties.id)
      ? ". Multiple dated source outlines overlap for this name." : "";
    return `${name}${control}${type}. Source dates: ${territoryYears(feature)}${alignment ? `. ${alignment}` : ""}${uncertainty}`;
  }

  function emphasizeTerritories() {
    const territories = historicalG.selectAll(".historical-territory");
    const requested = pinnedController || hoveredController;
    const controller = requested && territories.data().some(
      (feature) => feature.properties.controller === requested,
    ) ? requested : null;
    territories
      .attr("opacity", (feature) => (
        controller && feature.properties.controller !== controller ? 0.38 : 0.96
      ))
      .attr("stroke", (feature) => (
        controller && feature.properties.controller === controller
          ? C.accentDeep
          : (Math.floor(feature.properties.start) === currentBoundaryYear ? C.accentSoft : C.warBorder)
      ))
      .attr("stroke-width", (feature) => (
        controller && feature.properties.controller === controller
          ? 1.25
          : (Math.floor(feature.properties.start) === currentBoundaryYear ? 0.95 : 0.45)
      ))
      .attr("stroke-dasharray", (feature) => uncertainTerritoryIds.has(feature.properties.id) ? "3 2" : null);
  }

  let textMeasure = null;
  function mapTextWidth(text, weight = 400) {
    textMeasure ||= document.createElement("canvas").getContext("2d");
    textMeasure.font = `${weight} 9px "Public Sans",sans-serif`;
    return textMeasure.measureText(text).width;
  }
  function historyPlacementFrame() {
    const frame = [...mapFrame];
    if (historyDisplay.compare) frame[2] = frame[0] + (frame[2] - frame[0]) * historyDisplay.split / 100;
    return frame;
  }
  function fitsPlacement(box, occupied) {
    const frame = historyPlacementFrame();
    return box[0] >= frame[0] && box[1] >= frame[1] && box[2] <= frame[2] && box[3] <= frame[3] &&
      !occupied.some((other) => box[0] < other[2] + 4 && box[2] + 4 > other[0] && box[1] < other[3] + 4 && box[3] + 4 > other[1]);
  }
  function renderHistoricalLabels(features, flaggedNames = new Set()) {
    const byName = new Map();
    for (const feature of features) {
      const name = feature.properties.name;
      if (flaggedNames.has(name)) continue;
      const area = Number(feature.properties.area_km2) || d3.geoArea(feature);
      if (!byName.has(name) || area > byName.get(name).area) byName.set(name, { feature, area });
    }
    const limit = labelsVisible && size.w > 820 ? 8 : 0;
    const candidates = [...byName.values()]
      .filter((entry) => entry.area > 120000)
      .sort((a, b) => b.area - a.area);
    const labels = [], occupied = [...historicalPlacements];
    const transform = d3.zoomTransform(svg.node());
    for (const entry of candidates) {
      if (labels.length >= limit) break;
      const [x, y] = path.centroid(entry.feature);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      const text = entry.feature.properties.name
        .replace(/^Dominion of /i, "")
        .replace(/^United Kingdom of Great Britain and Ireland$/i, "United Kingdom");
      const [screenX, screenY] = transform.apply([x, y]), halfWidth = mapTextWidth(text, 500) / 2 + 3;
      const box = [screenX - halfWidth, screenY - 12, screenX + halfWidth, screenY + 4];
      if (!fitsPlacement(box, occupied)) continue;
      occupied.push(box);
      labels.push({ ...entry, x, y, text });
    }
    historicalLabelsG.selectAll("text").data(labels, (entry) => entry.feature.properties.id).join(
      (enter) => enter.append("text")
        .attr("text-anchor", "middle")
        .attr("paint-order", "stroke")
        .attr("stroke", C.paperSoft)
        .attr("stroke-width", 3)
        .attr("stroke-linejoin", "round")
        .attr("fill", C.anchorInk)
        .attr("font-family", "'Public Sans',sans-serif")
        .attr("font-weight", 500)
        .attr("letter-spacing", ".015em"),
      (update) => update,
      (exit) => exit.remove(),
    )
      .attr("x", (entry) => entry.x)
      .attr("y", (entry) => entry.y)
      .attr("data-fs", 9)
      .attr("font-size", `${9 / currentK}px`)
      .text((entry) => entry.text);
  }

  function renderHistoricalFlags(features, year) {
    const controllers = new Map();
    for (const feature of features) {
      const controller = feature.properties.controller || feature.properties.name;
      const name = administrationLabel(controller, features);
      const flag = flagFor(name, year);
      if (!flag) continue;
      const entity = feature.properties.name.replace(/\s*\([^)]*\)\s*$/, "");
      const core = entity === name ? 2 : flagFor(entity, year)?.countryName === flag.countryName ? 1 : 0;
      const area = Number(feature.properties.area_km2) || d3.geoArea(feature) * 6371 ** 2;
      const previous = controllers.get(controller);
      if (previous && (previous.core > core || (previous.core === core && previous.area >= area))) continue;
      const [x, y] = path.centroid(feature);
      if (Number.isFinite(x) && Number.isFinite(y)) {
        controllers.set(controller, { name, controller, entity: feature.properties.name, flag, core, area, x, y });
      }
    }
    const placed = [];
    historicalPlacements = [];
    const transform = d3.zoomTransform(svg.node());
    if (flagsVisible) {
      for (const entry of [...controllers.values()].sort((a, b) => (
        Number(b.controller === pinnedController) - Number(a.controller === pinnedController) ||
        Number(b.controller === activeFlagController) - Number(a.controller === activeFlagController) || b.area - a.area
      ))) {
        const [screenX, screenY] = transform.apply([entry.x, entry.y]);
        const neutral = entry.flag.neutralIdentifier;
        let showLabel = labelsVisible;
        let halfWidth = neutral ? Math.max(22, mapTextWidth(entry.name, 500) / 2 + 4) :
          Math.max(22, showLabel ? mapTextWidth(entry.name) / 2 + 3 : 0);
        let box = [screenX - halfWidth, screenY - (neutral ? 22 : 34), screenX + halfWidth, screenY + (neutral ? 22 : 10)];
        if (!fitsPlacement(box, historicalPlacements)) {
          if (neutral || !showLabel) continue;
          showLabel = false;
          halfWidth = 22;
          box = [screenX - halfWidth, screenY - 34, screenX + halfWidth, screenY + 10];
          if (!fitsPlacement(box, historicalPlacements)) continue;
        }
        historicalPlacements.push(box);
        placed.push({ ...entry, halfWidth, showLabel });
      }
    }
    const tabController = placed.find(entry => entry.controller === activeFlagController)?.controller ||
      placed.find(entry => entry.controller === pinnedController)?.controller || placed[0]?.controller;
    const accessibleLabel = entry => `Inspect ${entry.name} in ${year}${entry.flag.neutralIdentifier
      ? ". Text-only neutral territorial identifier, not a historical flag." : ""}`;
    const groups = historicalFlagsG.selectAll(".historical-flag").data(placed, (entry) => entry.name)
      .join((enter) => {
        const group = enter.append("g").attr("class", "historical-flag")
          .attr("role", "button").style("cursor", "pointer")
          .on("click", (event, entry) => {
            event.stopPropagation();
            if (controllerHandler) controllerHandler(entry.controller);
          })
          .on("keydown", (event, entry) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              if (controllerHandler) controllerHandler(entry.controller);
            } else browseMapMarkers(event, event.currentTarget, historicalFlagsG.selectAll(".historical-flag").nodes());
          });
        group.append("text").attr("text-anchor", "middle")
          .attr("font-family", "'Public Sans',sans-serif").attr("font-size", 9)
          .attr("fill", C.ink).attr("stroke", C.paperSoft).attr("stroke-width", 3).attr("paint-order", "stroke");
        group.append("title");
        return group;
      });
    groups.classed("historical-identifier", (entry) => Boolean(entry.flag.neutralIdentifier))
      .attr("data-neutral-identifier", (entry) => entry.flag.neutralIdentifier ? "true" : null)
      .attr("tabindex", (entry) => entry.controller === tabController ? 0 : -1)
      .attr("aria-keyshortcuts", "ArrowRight ArrowDown ArrowLeft ArrowUp Home End Enter Space")
      .attr("aria-label", (entry) => accessibleLabel(entry))
      .attr("data-map-focus", (entry) => `country:${entry.name}`)
      .attr("transform", (entry) => `translate(${entry.x},${entry.y}) scale(${1 / currentK})`);
    groups.selectAll(".historical-flag-frame").data((entry) => entry.flag.neutralIdentifier ? [] : [entry])
      .join((enter) => enter.insert("rect", "text").attr("class", "historical-flag-frame")
        .attr("x", -16).attr("y", -30).attr("width", 32).attr("height", 23)
        .attr("rx", 2).attr("fill", C.paperSoft).attr("stroke", C.rule));
    groups.selectAll("image").data((entry) => entry.flag.neutralIdentifier ? [] : [entry])
      .join((enter) => enter.insert("image", "text")
        .attr("x", -14).attr("y", -28).attr("width", 28).attr("height", 19))
      .on("error.flag", function (event, entry) {
        const group = d3.select(this.parentNode);
        d3.select(this).style("visibility", "hidden");
        group.select(".flag-image-placeholder").style("display", null);
        group.attr("aria-label", `${accessibleLabel(entry)}. The flag image could not load.`);
        group.select("title").text(`${entry.name}, ${year}. Flag image unavailable. The country details retain its dates and source.`);
        console.warn("A map flag image could not load; the country and source remain accessible.");
      })
      .on("load.flag", function (event, entry) {
        d3.select(this).style("visibility", null);
        const group = d3.select(this.parentNode);
        group.select(".flag-image-placeholder").style("display", "none");
        group.attr("aria-label", accessibleLabel(entry));
        group.select("title").text(`${entry.name}, ${year}. ${entry.flag.label}`);
      })
      .attr("href", (entry) => siteResource(entry.flag.src));
    groups.selectAll(".flag-image-placeholder").data((entry) => entry.flag.neutralIdentifier ? [] : [entry])
      .join((enter) => enter.insert("use", "text").attr("class", "flag-image-placeholder")
        .attr("href", "#icon-flag").attr("x", -12).attr("y", -29).attr("width", 24).attr("height", 24)
        .attr("fill", "none").attr("stroke", C.inkSoft).attr("stroke-width", 1.5)
        .style("display", "none"));
    groups.selectAll(".historical-identifier-hit").data((entry) => entry.flag.neutralIdentifier ? [entry] : [])
      .join((enter) => enter.insert("rect", "text").attr("class", "historical-identifier-hit")
        .attr("y", -22).attr("height", 44).attr("fill", "transparent").attr("aria-hidden", "true"))
      .attr("x", (entry) => -entry.halfWidth).attr("width", (entry) => entry.halfWidth * 2);
    groups.selectAll(".historical-flag-hit").data((entry) => entry.flag.neutralIdentifier ? [] : [entry])
      .join((enter) => enter.insert("rect", "text").attr("class", "historical-flag-hit")
        .attr("x", -22).attr("y", -34).attr("width", 44).attr("height", 44)
        .attr("fill", "transparent").attr("aria-hidden", "true"));
    groups.select("text").attr("y", (entry) => entry.flag.neutralIdentifier ? 3 : 5)
      .attr("font-weight", (entry) => entry.flag.neutralIdentifier ? 500 : 400)
      .text((entry) => entry.showLabel || entry.flag.neutralIdentifier ? entry.name : "");
    groups.select("title").text((entry) => `${entry.name}, ${year}. ${entry.flag.label}${entry.flag.neutralIdentifier && entry.flag.note ? `. Source note: ${entry.flag.note}` : ""}`);
    return new Set(placed.map((entry) => entry.entity));
  }

  function showHistoricalBoundaries(year, period) {
    currentTerritoryPeriod = period;
    currentBoundaryYear = year;
    if (!historicalFeatures) {
      historicalG.style("display", "none");
      historicalLabelsG.style("display", "none");
      historicalFlagsG.style("display", "none");
      countriesG.style("display", null);
      ensureHistoricalBoundaries();
      return false;
    }
    const active = activeTerritories(year)
      .sort((a, b) => Number(a.properties.kind === "occupation") - Number(b.properties.kind === "occupation"));
    visibleTerritories = active;
    uncertainTerritoryIds = uncertainRecords(year);
    document.documentElement.dataset.historicalBoundaries = "ready";
    countriesG.style("display", null);
    historicalG.style("display", null);
    historicalLabelsG.style("display", null);
    historicalFlagsG.style("display", view === "patterns" ? null : "none");
    historicalG.selectAll(".historical-territory").data(active, (feature) => feature.properties.id).join(
      (enter) => enter.append("path")
        .attr("class", "historical-territory")
        .attr("vector-effect", "non-scaling-stroke")
        .style("cursor", "pointer")
        .on("mouseenter.territory", (event, feature) => {
          hoveredController = feature.properties.controller;
          emphasizeTerritories();
          showTip(event, territoryDescription(feature));
        })
        .on("mousemove.territory", (event) => moveTip(event))
        .on("mouseleave.territory", () => {
          hoveredController = null;
          emphasizeTerritories();
          hideTip();
        })
        .on("click.territory", (event, feature) => {
          event.stopPropagation();
          const controller = feature.properties.controller;
          if (controllerHandler) controllerHandler(pinnedController === controller ? null : controller);
          else showTip(event, territoryDescription(feature));
        }),
      (update) => update,
      (exit) => exit.remove(),
    )
      .order()
      .attr("d", path)
      .attr("fill", (feature) => territoryFill(feature, period))
      .attr("data-controller", (feature) => feature.properties.controller)
      .attr("data-territory", (feature) => feature.properties.name)
      .attr("data-new-territory", (feature) => Math.floor(feature.properties.start) === year ? "true" : null)
      .attr("data-boundary-uncertain", (feature) => uncertainTerritoryIds.has(feature.properties.id) ? "true" : null)
      .attr("data-war-side", (feature) => territoryStatus(feature, period));
    emphasizeTerritories();
    const flaggedNames = renderHistoricalFlags(active, year);
    renderHistoricalLabels(active, flaggedNames);
    applyHistoryDisplay();
    return true;
  }

  function hideHistoricalBoundaries() {
    currentTerritoryPeriod = null;
    currentBoundaryYear = null;
    hoveredController = null;
    pinnedController = null;
    visibleTerritories = [];
    historicalPlacements = [];
    uncertainTerritoryIds = new Set();
    historicalG.style("display", "none");
    historicalLabelsG.style("display", "none");
    historicalFlagsG.style("display", "none");
    countriesG.style("display", null);
    document.documentElement.dataset.historicalBoundaries =
      historicalFeatures ? "inactive" : historicalStatus;
  }

  function buildGlobeRoutePool() {
    if (!store) { globeRoutePool = []; return; }
    globeRoutePool = store.journeys.map((journey) => {
      const coordinates = [];
      for (const waypoint of journey.routeWaypoints || []) {
        if (!hasCoordinates(waypoint) || !personalPrecise(waypoint)) continue;
        const coordinate = [waypoint.lng, waypoint.lat];
        const previous = coordinates[coordinates.length - 1];
        if (!previous || previous[0] !== coordinate[0] || previous[1] !== coordinate[1]) {
          coordinates.push(coordinate);
        }
      }
      const distance = coordinates.slice(1).reduce(
        (total, coordinate, index) => total + d3.geoDistance(coordinates[index], coordinate),
        0,
      );
      return {
        id: journey.id,
        group: journey.group,
        coordinates,
        distance,
      };
    }).filter((journey) => journey.coordinates.length >= 2 && journey.distance > 0.14)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  function rotateGlobeRoutes(force = false) {
    if (!globeG?._routes || !globeRoutePool.length) return;
    if (!force) globeRouteCursor = (globeRouteCursor + 29) % globeRoutePool.length;
    const selected = [];
    for (let offset = 0; offset < globeRoutePool.length && selected.length < 5; offset++) {
      const candidate = globeRoutePool[(globeRouteCursor + offset * 17) % globeRoutePool.length];
      const start = candidate.coordinates[0];
      const end = candidate.coordinates[candidate.coordinates.length - 1];
      const distinct = selected.every((other) => {
        const otherStart = other.coordinates[0];
        const otherEnd = other.coordinates[other.coordinates.length - 1];
        return d3.geoDistance(start, otherStart) > 0.14 ||
          d3.geoDistance(end, otherEnd) > 0.14;
      });
      if (distinct) selected.push(candidate);
    }
    globeRouteBatch = selected;
    globeRouteChangedAt = performance.now();

    const routeSelection = globeG._routes.selectAll("g.globe-route")
      .data(globeRouteBatch, (journey) => journey.id);
    routeSelection.exit().remove();
    const routeEnter = routeSelection.enter().append("g")
      .attr("class", "globe-route")
      .attr("opacity", 1);
    routeEnter.append("path")
      .attr("class", "globe-route-halo")
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("stroke", C.paperSoft)
      .attr("stroke-width", 4)
      .attr("opacity", 0.38);
    routeEnter.append("path")
      .attr("class", "globe-route-core")
      .attr("fill", "none")
      .attr("stroke-linecap", "round")
      .attr("stroke-width", 1.35)
      .attr("opacity", 0.76);
    routeEnter.merge(routeSelection).select(".globe-route-core")
      .attr("stroke", (journey) => GROUP_COLOR[journey.group] || C.accent);

    const travelerSelection = globeG._travelers.selectAll("circle")
      .data(globeRouteBatch, (journey) => journey.id);
    travelerSelection.exit().remove();
    travelerSelection.enter().append("circle")
      .attr("class", "globe-traveler")
      .attr("r", 3)
      .attr("fill", C.accentDeep)
      .attr("stroke", C.paperSoft)
      .attr("stroke-width", 1.5)
      .attr("opacity", 0.96)
      .merge(travelerSelection)
      .attr("fill", (journey) => GROUP_COLOR[journey.group] || C.accent);
  }

  function pointAlongRoute(coordinates, progress) {
    if (!coordinates.length) return null;
    if (coordinates.length === 1) return coordinates[0];
    const scaled = progress * (coordinates.length - 1);
    const index = Math.min(coordinates.length - 2, Math.floor(scaled));
    return d3.geoInterpolate(coordinates[index], coordinates[index + 1])(scaled - index);
  }

  // ---- globe -----------------------------------------------------------------
  function showGlobe(on) {
    globeG.style("display", on ? null : "none");
    camera.style("display", on ? "none" : null);
    if (on) { drawGlobe(); startRotate(); } else stopRotate();
  }
  function drawGlobe() {
    globeG.selectAll("*").remove();
    const c = gProjection.translate(), r = gProjection.scale();
    globeG.append("circle").attr("class", "globe-shell")
      .attr("cx", c[0]).attr("cy", c[1]).attr("r", r)
      .attr("fill", C.globeOcean).attr("fill-opacity", 0.68)
      .attr("stroke", C.accentSoft).attr("stroke-opacity", 0.5).attr("stroke-width", 1.1);
    const land = globeG.append("g");
    land.selectAll("path").data(world.features).enter().append("path")
      .attr("fill", C.globeLand).attr("fill-opacity", 0.78)
      .attr("stroke", C.landStroke).attr("stroke-width", 0.4);
    const graticule = globeG.append("path")
      .attr("class", "globe-graticule")
      .datum(d3.geoGraticule10())
      .attr("fill", "none")
      .attr("stroke", C.globeGrid)
      .attr("stroke-width", 0.55)
      .attr("stroke-opacity", 0.34);
    const routes = globeG.append("g").attr("class", "globe-routes");
    const travelers = globeG.append("g").attr("class", "globe-travelers");
    const dots = globeG.append("g");
    globeG._land = land;
    globeG._graticule = graticule;
    globeG._routes = routes;
    globeG._travelers = travelers;
    globeG._dots = dots;
    rotateGlobeRoutes(true);
    redrawGlobe();
  }
  function redrawGlobe(now = performance.now()) {
    const land = globeG._land, graticule = globeG._graticule, routes = globeG._routes;
    const travelers = globeG._travelers, dots = globeG._dots;
    if (!land) return;
    if (now - globeRouteChangedAt > 11000) rotateGlobeRoutes();
    gProjection.rotate(rot);
    land.selectAll("path").attr("d", gPath);
    graticule.attr("d", gPath);
    const center = [-rot[0], -rot[1]];
    routes.selectAll("path").attr("d", (journey) => gPath({
      type: "LineString",
      coordinates: journey.coordinates,
    }));
    travelers.selectAll("circle").each(function (journey, index) {
      const point = pointAlongRoute(
        journey.coordinates,
        (globePhase + index / Math.max(1, globeRouteBatch.length)) % 1,
      );
      const visible = point && d3.geoDistance(point, center) < Math.PI / 2;
      if (!visible) {
        d3.select(this).attr("display", "none");
        return;
      }
      const projected = gProjection(point);
      d3.select(this).attr("display", null)
        .attr("cx", projected[0]).attr("cy", projected[1]);
    });
    const sel = dots.selectAll("circle").data(store ? store.journeys : [], (j) => j.id);
    sel.enter().append("circle").attr("r", 1.2).merge(sel).each(function (j) {
      const home = j.routeStart;
      if (!home) { d3.select(this).attr("display", "none"); return; }
      const vis = d3.geoDistance([home.lng, home.lat], center) < Math.PI / 2;
      if (!vis) { d3.select(this).attr("display", "none"); return; }
      const p = gProjection([home.lng, home.lat]);
      d3.select(this).attr("display", null).attr("cx", p[0]).attr("cy", p[1])
        .attr("fill", GROUP_COLOR[j.group] || C.accent).attr("opacity", 0.28);
    });
    sel.exit().remove();
  }
  function startRotate() {
    stopRotate();
    if (document.hidden) { redrawGlobe(); return; }
    let previous = performance.now();
    const step = (now) => {
      const elapsed = Math.max(0, Math.min(64, now - previous));
      previous = now;
      rot[0] += elapsed * .004;
      globePhase = (globePhase + elapsed * .00005) % 1;
      redrawGlobe(now);
      rotateRAF = requestAnimationFrame(step);
    };
    rotateRAF = requestAnimationFrame(step);
  }
  function stopRotate() { if (rotateRAF) cancelAnimationFrame(rotateRAF); rotateRAF = null; }

  // ---- per-view rendering ----------------------------------------------------
  api.render = function (v, ctx, reframe = false) {
    mapContext = ctx;
    api._last = (forceFrame = false) => api.render(v, {
      ...ctx,
      historyCompare: historyDisplay.compare,
      historyOpacity: historyDisplay.opacity,
      historySplit: historyDisplay.split,
    }, forceFrame);
    if (!overlayG) return;
    const focusKey = container.contains(document.activeElement) ? document.activeElement.dataset.mapFocus : null;
    const changed = v !== view; view = v;
    controllerHandler = v === "patterns" ? ctx.onController : null;
    const nextController = v === "patterns" && ctx.patternsLayer !== "origins" ? ctx.historyCountry : null;
    const controllerChanged = pinnedController !== nextController;
    pinnedController = nextController || null;
    flagsVisible = v === "patterns" && ctx.historyFlags !== false;
    labelsVisible = ctx.historyLabels !== false;
    historyDisplay = v === "patterns" && ctx.patternsLayer !== "origins"
      ? { compare: Boolean(ctx.historyCompare), split: ctx.historySplit ?? 50, opacity: ctx.historyOpacity ?? 1 }
      : { compare: false, split: 50, opacity: 1 };
    const frame = availableMapFrame();
    const frameChanged = !mapFrame || frame.some((value, index) => value !== mapFrame[index]);
    if (frameChanged) layout();
    // A shared or hidden browser tab can begin with no measurable map area.
    if (!projection) return;
    svg.select(".atlas-bg").attr("fill-opacity", v === "landing" ? 0.12 : 1);
    if (v === "landing") { svg.style("pointer-events", "none"); showGlobe(true); return; }
    showGlobe(false);
    const interactive = v === "explore" || v === "patterns";
    svg.style("pointer-events", interactive ? "auto" : "none")
      .attr("aria-label", v === "explore" ? "Source place references. Select a marker to read the source." : "Historical context map. Select a marker to inspect its sources.");
    const historicalReady = ctx.boundaryYear != null
      ? showHistoricalBoundaries(ctx.boundaryYear, ctx.warPeriod)
      : (hideHistoricalBoundaries(), false);
    if (v === "patterns" && ctx.patternsLayer === "origins") {
      hideHistoricalBoundaries();
      paintChoropleth(true, ctx.onOrigin);
    } else if (historicalReady) {
      paintChoropleth(false);
    } else if (ctx.warPeriod && ctx.boundaryYear == null) {
      paintWarContext(ctx.warPeriod);
    } else {
      paintChoropleth(false);
    }
    if (v === "explore") {
      clearOverlay();
      const clusters = drawExplore(ctx);
      const journey = store.byId.get(ctx.selectedId);
      const place = journey?.waypoints[ctx.activePlaceIndex];
      const nextPlaceKey = place && hasMapPoint(place) ? `${journey.id}:${ctx.activePlaceIndex}` : null;
      const extentKey = journey ? null : clusters.map((cluster) => cluster.key).join("\n");
      const needsFrame = changed || frameChanged || reframe || selectedJourney !== ctx.selectedId || selectedPlaceKey !== nextPlaceKey;
      if (nextPlaceKey) {
        if (needsFrame) fitReferences([place]);
      } else if (needsFrame || (!journey && collectionExtentKey !== extentKey)) {
        if (journey) focusJourney(journey);
        else fitReferences(clusters);
      }
      selectedJourney = ctx.selectedId;
      selectedPlaceKey = nextPlaceKey;
      if (!journey) collectionExtentKey = extentKey;
      layoutCollectionReferences();
    } else if (v === "patterns") {
      clearOverlay();
      const eventKey = ctx.activePatternEvent?.key || null;
      drawPatterns(ctx, changed || frameChanged || reframe || selectedPatternEvent !== eventKey);
      selectedPatternEvent = eventKey;
      if (pinnedController && (controllerChanged || changed || frameChanged || reframe)) {
        focusController(pinnedController, ctx.scrubYear);
      } else if ((changed || frameChanged || reframe) && !ctx.activePatternEvent) api.resetCamera();
    }
    if (focusKey && !container.inert) {
      const target = svg.select(`[data-map-focus="${CSS.escape(focusKey)}"]`).node();
      if (target?.getClientRects().length) target.focus({ preventScroll: true });
      else api.focusMap();
    }
  };

  function referenceKind(point) {
    if (point.evidenceScope !== "personal" && !point.verified) return "review";
    return personalPrecise(point) ? "precise" : "broad";
  }
  function referenceDescription(point) {
    const meaning = {
      precise: "Personal city or site reference.",
      broad: "Broad area reference, not a precise travel point.",
      review: "Unreviewed source mention, not verified personal travel.",
    }[referenceKind(point)];
    return `${point.canonical || point.asWritten || "Unnamed place"}. ${point.locationPrecision || "Unknown"}-level reference. ${meaning} Open the source entry.`;
  }
  function referenceSymbol(group, point, kind, radius, color) {
    dot(group, point.px, point.py, { r: Math.max(12, radius + 4), fill: "transparent" })
      .attr("class", "map-reference-hit").attr("aria-hidden", "true");
    dot(group, point.px, point.py, {
      r: radius, fill: kind === "precise" ? color : "none",
      stroke: kind === "precise" ? C.paperSoft : color, sw: kind === "precise" ? 1 : 1.8,
    })
      .attr("class", "map-reference-symbol").attr("aria-hidden", "true")
      .attr("stroke-dasharray", kind === "review" ? "3 2" : null)
      .style("pointer-events", "none");
  }
  function collectionClusters(matches = () => true) {
    const places = new Map();
    for (const journey of store.journeys) {
      if (matches && !matches(journey)) continue;
      for (const point of mappedPoints(journey)) {
        const key = JSON.stringify([point.canonical, point.lng, point.lat]);
        if (!places.has(key)) places.set(key, {
          key, canonical: point.canonical, px: point.px, py: point.py,
          accounts: new Set(), precisions: new Set(), review: false, broad: false,
        });
        const cluster = places.get(key);
        cluster.accounts.add(journey.id);
        cluster.precisions.add(point.locationPrecision || "unknown");
        cluster.review ||= referenceKind(point) === "review";
        cluster.broad ||= !["city", "site"].includes(point.locationPrecision);
      }
    }
    return [...places.values()].map((cluster) => ({
      ...cluster, count: cluster.accounts.size,
      locationPrecision: cluster.broad ? "mixed" : "city",
      kind: cluster.review ? "review" : cluster.broad ? "broad" : "precise",
    })).sort((a, b) => String(a.canonical).localeCompare(String(b.canonical)) || a.key.localeCompare(b.key));
  }

  function drawExplore(ctx) {
    const g = overlayG;
    const sel = store.byId.get(ctx.selectedId);
    if (sel) {
      const wp = routePoints(sel);
      const col = GROUP_COLOR[sel.group] || C.accent;
      route(g, wp, {
        className: "explore-route",
        color: col,
        width: 2.2,
        op: 0.9,
        animate: ctx.selectedId !== selectedJourney,
      });
      sel.waypoints.forEach((w, index) => {
        if (!hasMapPoint(w)) return;
        const kind = referenceKind(w), description = referenceDescription(w);
        const marker = g.append("g").datum(w)
          .attr("class", `account-place-marker map-reference--${kind}`).attr("data-place-index", index)
          .attr("data-map-focus", `place:${sel.id}:${index}`)
          .attr("data-precision", w.locationPrecision || "unknown")
          .attr("aria-pressed", index === ctx.activePlaceIndex ? "true" : "false")
          .attr("role", "button").attr("tabindex", 0).attr("aria-label", description)
          .style("cursor", "pointer").attr("pointer-events", "all");
        referenceSymbol(marker, w, kind, kind === "precise" ? 5 : 6, col);
        marker.append("title").text(description);
        if (kind === "precise" && (w.liberation || w.newLife)) dot(g, w.px, w.py, { r: 8, fill: "none", stroke: col, sw: 1.2, op: 0.35 })
          .style("pointer-events", "none");
      });
      const active = sel.waypoints[ctx.activePlaceIndex];
      if (active && hasMapPoint(active)) {
        dot(g, active.px, active.py, { r: 10, fill: "none", stroke: col, sw: 2 })
          .attr("class", "selected-place-ring").style("pointer-events", "none");
        label(g, active.px, active.py, active.canonical, { dy: 20, fs: 11, fill: col, halo: true })
          .attr("class", "selected-place-label").style("pointer-events", "none");
      }
      return [];
    }
    const clusters = collectionClusters(ctx.matches);
    if (!clusters.some((cluster) => cluster.key === activeClusterKey)) activeClusterKey = clusters[0]?.key || null;
    for (const cluster of clusters) {
      const radius = Math.min(17, 5 + Math.sqrt(cluster.count) * 1.4);
      const precision = [...cluster.precisions].sort().join(" / ");
      const description = `${cluster.canonical}. ${precision}-level reference. ${cluster.count} ${cluster.count === 1 ? "account names" : "accounts name"} this place.${cluster.review ? " Includes unreviewed mentions." : ""} Naming a place does not establish verified presence. Open these accounts.`;
      const marker = g.append("g").datum(cluster)
        .attr("class", `place-cluster map-reference--${cluster.kind}`)
        .attr("role", "button").attr("tabindex", cluster.key === activeClusterKey ? 0 : -1)
        .attr("data-map-focus", `cluster:${cluster.key}`)
        .attr("data-place-canonical", cluster.canonical).attr("data-precision", precision)
        .attr("data-account-ids", JSON.stringify([...cluster.accounts].sort()))
        .attr("data-account-count", cluster.count).attr("aria-label", description)
        .attr("aria-keyshortcuts", "ArrowRight ArrowDown ArrowLeft ArrowUp Home End Enter Space")
        .attr("pointer-events", "all").style("cursor", "pointer");
      referenceSymbol(marker, cluster, cluster.kind, radius, C.accentDeep);
      marker.append("title").text(description);
    }
    const counts = g.append("g").attr("class", "collection-counts")
      .attr("aria-hidden", "true").style("pointer-events", "none");
    for (const cluster of clusters.filter(item => item.count > 1)) {
      label(counts, cluster.px, cluster.py, cluster.count, {
        fs: 10, dy: -3, fill: cluster.kind === "precise" ? C.paperSoft : C.accentDeep,
        halo: cluster.kind !== "precise",
      }).datum(cluster).attr("class", "place-cluster-count");
    }
    return clusters;
  }

  function layoutCollectionReferences() {
    const markers = overlayG.selectAll(".place-cluster").nodes();
    if (!markers.length) return;
    const focused = document.activeElement;
    const transform = d3.zoomTransform(svg.node());
    const occupied = [], visible = new Set();
    const radiusFor = (count) => Math.min(17, 5 + Math.sqrt(count) * 1.4);
    const ranked = [...markers].sort((a, b) => Number(b === focused) - Number(a === focused) ||
      b.__data__.count - a.__data__.count || a.__data__.key.localeCompare(b.__data__.key));
    // Keep every place accessible; only count labels compete for map space.
    for (const marker of ranked) {
      const cluster = marker.__data__;
      if (cluster.count < 2) continue;
      const [x, y] = transform.apply([cluster.px, cluster.py]);
      const radius = radiusFor(cluster.count) + 3;
      if (mapFrame && (x < mapFrame[0] || x > mapFrame[2] || y < mapFrame[1] || y > mapFrame[3])) continue;
      if (occupied.some(item => Math.hypot(x - item.x, y - item.y) < radius + item.radius)) continue;
      occupied.push({ x, y, radius });
      visible.add(cluster.key);
    }
    for (const marker of markers) {
      const cluster = marker.__data__;
      const radius = visible.has(cluster.key) ? radiusFor(cluster.count) : 4;
      const symbol = marker.querySelector(".map-reference-symbol");
      symbol.setAttribute("data-r", radius);
      symbol.setAttribute("r", radius / currentK);
      const hit = marker.querySelector(".map-reference-hit");
      const hitRadius = Math.max(12, radius + 4);
      hit.setAttribute("data-r", hitRadius);
      hit.setAttribute("r", hitRadius / currentK);
    }
    overlayG.selectAll(".place-cluster-count").style("display", cluster => visible.has(cluster.key) ? null : "none");
  }

  function drawPatterns(ctx, focusEvent) {
    const g = overlayG;
    if (ctx.patternsLayer === "origins") { drawOrigins(g); return; }
    const activeEvent = ctx.historyTestimony === false ? null : ctx.activePatternEvent;
    const activeIds = new Set(activeEvent?.people.slice(0, 4).map((person) => person.id) || []);
    const activeConflict = ctx.warPeriod?.archive_conflict;

    const corridors = ctx.historyRoutes !== false ? (ctx.datedCorridors || []) : [];
    const maximumCorridor = Math.max(1, ...corridors.map((corridor) => corridor.count));
    for (const corridor of corridors) {
      const a = projection([corridor.a.lng, corridor.a.lat]);
      const b = projection([corridor.b.lng, corridor.b.lat]);
      if (!a || !b) continue;
      const datum = { ...corridor, a: { px: a[0], py: a[1] }, b: { px: b[0], py: b[1] } };
      g.append("path")
        .datum(datum)
        .attr("class", "service-corridor")
        .attr("d", legPath(datum.a, datum.b))
        .attr("fill", "none")
        .attr("stroke", C.accentDeep)
        .attr("stroke-width", 0.8 + Math.sqrt(corridor.count / maximumCorridor) * 1.5)
        .attr("stroke-linecap", "round")
        .attr("vector-effect", "non-scaling-stroke")
        .attr("opacity", 0.18 + corridor.count / maximumCorridor * 0.22)
        .style("pointer-events", "stroke")
        .style("cursor", "pointer")
        .on("mouseenter", (event) => showTip(
          event,
          `${corridor.a.canonical} to ${corridor.b.canonical}. ${corridor.count} veterans`,
        ))
        .on("mousemove", (event) => moveTip(event))
        .on("mouseleave", hideTip);
    }

    for (const journey of store.journeys) {
      if (!activeIds.has(journey.id)) continue;
      const waypoints = routePoints(journey).filter((waypoint) => waypoint.historyYear === ctx.scrubYear);
      if (waypoints.length < 2) continue;
      g.append("path")
        .datum({ account: journey.id, year: ctx.scrubYear, waypoints })
        .attr("class", "selected-testimony-route")
        .attr("d", journeyPath(waypoints))
        .attr("fill", "none")
        .attr("stroke", GROUP_COLOR[journey.group] || C.accent)
        .attr("stroke-width", 1.6)
        .attr("stroke-linecap", "round")
        .attr("stroke-linejoin", "round")
        .attr("vector-effect", "non-scaling-stroke")
        .attr("opacity", 0.64);
    }

    let activePoint = null;
    const rankedEvents = [...(ctx.historyTestimony === false ? [] : (ctx.patternEvents || []))]
      .sort((a, b) => b.count - a.count || a.place.localeCompare(b.place));
    const visibleEvents = rankedEvents.slice(0, size.w <= 820 ? 9 : 14);
    if (activeEvent && !visibleEvents.some((event) => event.key === activeEvent.key)) {
      visibleEvents.push(activeEvent);
    }
    for (const event of visibleEvents) {
      const point = projection([event.lng, event.lat]);
      if (!point) continue;
      const active = event.key === activeEvent?.key;
      const radius = Math.min(12, 3.8 + Math.sqrt(event.count) * 1.5);
      if (active) {
        dot(g, point[0], point[1], { r: radius + 7, fill: C.accent, op: 0.08 });
        dot(g, point[0], point[1], { r: radius + 3, fill: "none", stroke: C.accentDeep, sw: 1.5, op: 0.8 });
        activePoint = { x: point[0], y: point[1] };
      }
      const marker = dot(g, point[0], point[1], {
        r: radius,
        fill: active ? C.accentDeep : "rgba(250,251,252,.9)",
        stroke: active ? C.accentDeep : C.accentSoft,
        sw: active ? 2 : 1,
        op: active ? 0.98 : 0.76,
      });
      marker.attr("class", "pattern-event-marker")
        .datum(event)
        .attr("data-map-focus", `event:${event.key}`)
        .attr("role", "button")
        .attr("tabindex", 0)
        .attr("aria-pressed", active ? "true" : "false")
        .attr("aria-label", `${event.year}, ${event.place}, ${event.count} ${event.count === 1 ? "testimony" : "testimonies"}`)
        .style("cursor", "pointer").attr("pointer-events", "all")
        .on("click", () => ctx.onEvent && ctx.onEvent(event.key))
        .on("keydown", (keyboardEvent) => {
          if (keyboardEvent.key === "Enter" || keyboardEvent.key === " ") {
            keyboardEvent.preventDefault();
            if (ctx.onEvent) ctx.onEvent(event.key);
          }
        })
        .on("mouseenter", (pointerEvent) => showTip(
          pointerEvent,
          `${event.year}, ${event.place}. ${event.count} ${event.count === 1 ? "interview" : "interviews"}`,
        ))
        .on("mousemove", (pointerEvent) => moveTip(pointerEvent))
        .on("mouseleave", hideTip);
      if (active && event.count > 1) {
        label(g, point[0], point[1], `${event.count}`, {
          fs: 10,
          dy: -3,
          weight: 600,
          fill: active ? C.paperSoft : C.accentDeep,
        });
      }
    }
    if (activePoint && focusEvent) moveCamera(activePoint, size.w <= 820 ? 1.1 : 1.18);
  }

  function drawOrigins(g) {
    const placed = new Map();
    for (const j of store.journeys) {
      const home = j.routeStart; if (!home || home.px == null || !j.originCountry) continue;
      if (!placed.has(j.originCountry)) placed.set(j.originCountry, { x: 0, y: 0, n: 0 });
      const e = placed.get(j.originCountry); e.x += home.px; e.y += home.py; e.n++;
    }
    const labels = [];
    for (const [country, e] of [...placed].sort((a, b) => b[1].n - a[1].n)) {
      const n = store.originCounts.get(country) || e.n;
      if (n < 3) continue;
      const cx = e.x / e.n, cy = e.y / e.n;
      if (labels.some((point) => Math.abs(cx - point.x) < 32 && Math.abs(cy - point.y) < 22)) continue;
      labels.push({ x: cx, y: cy });
      dot(g, cx, cy, { r: 2.5, fill: C.accentDeep, op: 0.85 });
      label(g, cx, cy, `${n}`, { fs: 12, dy: 10, weight: 600, fill: C.accentDeep, halo: true });
    }
  }

  // ---- account map overview ------------------------------------------------
  api.drawMini = function (svgEl, j) {
    if (!svgEl || !j || !world) {
      console.warn("The account map cannot render before its geography and account are available.");
      return false;
    }
    const sel = d3.select(svgEl);
    sel.selectAll("*").remove();
    const W = 340, H = 190, pad = 24;
    sel.attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `Present-day map of the recorded place references in ${j.name}'s account`);
    sel.append("title").text(`Recorded places for ${j.name}`);
    sel.append("rect").attr("class", "mini-ocean").attr("width", W).attr("height", H).attr("fill", C.ocean);
    const pts = (j.waypoints || []).filter(hasCoordinates);
    if (!pts.length) {
      sel.attr("data-mini-state", "unlocated");
      sel.append("text").attr("x", W / 2).attr("y", H / 2).attr("text-anchor", "middle")
        .attr("fill", C.inkSoft).attr("font-size", 12).text("No source locations have been mapped yet.");
      console.warn(`The account map for ${j.id} has no located source references.`);
      return false;
    }

    // The overview has its own unclipped camera; main-map zoom and sheet size
    // must not change its geography or split nearby places across the date line.
    const longitudes = [...new Set(pts.map(point => ((point.lng % 360) + 360) % 360))].sort((a, b) => a - b);
    let widestGap = -1, arcStart = 0;
    longitudes.forEach((value, index) => {
      const next = index + 1 < longitudes.length ? longitudes[index + 1] : longitudes[0] + 360;
      if (next - value > widestGap) { widestGap = next - value; arcStart = next % 360; }
    });
    const centralLongitude = (arcStart + (360 - widestGap) / 2 + 180) % 360 - 180;
    const miniProjection = d3.geoEqualEarth().rotate([-centralLongitude, 0]).scale(1).translate([0, 0]);
    const miniPath = d3.geoPath(miniProjection);
    const worldBounds = miniPath.bounds({ type: "Sphere" });
    const worldScale = Math.min(W / (worldBounds[1][0] - worldBounds[0][0]), H / (worldBounds[1][1] - worldBounds[0][1]));
    const positions = pts.map(point => miniProjection([point.lng, point.lat]));
    const xs = positions.map(point => point[0]), ys = positions.map(point => point[1]);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const k = Math.min((W - pad * 2) / (maxx - minx), (H - pad * 2) / (maxy - miny),
      worldScale * (pts.every(point => ["city", "site"].includes(point.locationPrecision)) ? 8 : 4));
    miniProjection.scale(k).translate([W / 2 - (minx + maxx) / 2 * k, H / 2 - (miny + maxy) / 2 * k])
      .clipExtent([[0, 0], [W, H]]);
    const land = world.features.filter(feature => feature.properties.name !== "Antarctica")
      .map(feature => ({ feature, d: miniPath(feature) })).filter(entry => entry.d);
    sel.append("g").attr("class", "mini-geography").attr("aria-hidden", "true")
      .selectAll("path").data(land).join("path")
      .attr("class", "mini-country").attr("data-country", entry => entry.feature.properties.name)
      .attr("d", entry => entry.d).attr("fill", C.land).attr("stroke", C.landStroke).attr("stroke-width", .6);
    const position = point => {
      const [x, y] = miniProjection([point.lng, point.lat]);
      return { x, y };
    };
    const routeReferences = (j.routeWaypoints || []).filter(point => hasCoordinates(point) && personalPrecise(point));
    const route = journeyPath(routeReferences.map(position));
    const col = GROUP_COLOR[j.group] || C.accent;
    if (route) sel.append("path").attr("d", route)
      .attr("class", "mini-route").attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.8)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round")
      .attr("paint-order", "stroke");
    sel.append("desc").text(`Current borders for orientation, not historical territorial claims. ${
      route ? "Lines connect source-linked city and site references, not exact travel paths." : "These references do not establish a connected journey."
    } ${pts.map(point => point.canonical).join("; ")}.`);
    const occupied = pts.map(point => {
      const { x, y } = position(point);
      return [x - 6, y - 6, x + 6, y + 6];
    });
    for (const point of pts) {
      const p = position(point), kind = referenceKind(point);
      sel.append("circle").datum(point).attr("cx", p.x).attr("cy", p.y).attr("r", kind === "precise" ? 3.5 : 4.5)
        .attr("class", `mini-map-reference map-reference--${kind}`)
        .attr("fill", kind === "precise" ? col : C.ocean)
        .attr("stroke", col).attr("stroke-width", kind === "precise" ? .8 : 1.2)
        .attr("stroke-dasharray", kind === "review" ? "2 1.5" : null)
        .append("title").text(`${point.canonical}. ${kind === "precise" ? "Source-linked city or site reference"
          : kind === "broad" ? "Broad geographic reference" : "Source mention needing review"}.`);
    }
    const labelled = new Set();
    let labels = 0;
    for (const point of pts) {
      if (labelled.has(point.canonical) || labels >= 6) continue;
      labelled.add(point.canonical);
      const text = point.canonical.split(",")[0], width = mapTextWidth(text, 500);
      const p = position(point);
      const candidates = [
        [p.x + 8, p.y - 5], [p.x - width - 8, p.y - 5],
        [p.x - width / 2, p.y - 20], [p.x - width / 2, p.y + 9],
      ];
      const candidate = candidates.find(([x, y]) => {
        const box = [x - 2, y - 2, x + width + 2, y + 13];
        return box[0] >= 6 && box[1] >= 6 && box[2] <= W - 6 && box[3] <= H - 6 &&
          !occupied.some(other => box[0] < other[2] && box[2] > other[0] && box[1] < other[3] && box[3] > other[1]);
      });
      if (!candidate) continue;
      const [x, y] = candidate;
      occupied.push([x - 2, y - 2, x + width + 2, y + 13]);
      sel.append("text").attr("class", "mini-place-label").attr("x", x).attr("y", y + 9)
        .attr("font-family", "'Public Sans',sans-serif").attr("font-size", 9).attr("font-weight", 500)
        .attr("fill", C.ink).attr("stroke", C.paperSoft).attr("stroke-width", 2.5)
        .attr("stroke-linejoin", "round").attr("paint-order", "stroke").text(text);
      labels++;
    }
    sel.attr("data-mini-state", "ready");
    return true;
  };

  return api;
}
