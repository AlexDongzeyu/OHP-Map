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
import { C, GROUP_COLOR, motionEnabled } from "./config.js";

const d3 = window.d3;
const topojson = window.topojson;

export function createAtlas(container) {
  let world = null;
  let svg, globeG, camera, countriesG, historicalG, historicalLabelsG, overlayG, countrySel = null;
  let projection, path, gProjection, gPath;
  let size = { w: 0, h: 0 }, currentK = 1;
  let mapFrame = null;
  let selectedJourney = null;
  let store = null, tipEl = null, zoom = null;
  let view = null, rotateRAF = null, rot = [-40, -32, 0];
  let globeRoutePool = [], globeRouteBatch = [], globeRouteCursor = 0;
  let globeRouteChangedAt = 0, globePhase = 0;
  let historicalFeatures = null, historicalPromise = null;
  let currentTerritoryPeriod = null;
  let currentBoundaryYear = null;
  let hoveredController = null, pinnedController = null;
  const api = {};

  api.ready = (async function init() {
    world = await fetch("data/atlas-world.json", { cache: "force-cache" }).then((r) => r.json());
    build();
    layout();
    return api;
  })();

  api.setStore = (s) => { store = s; buildGlobeRoutePool(); };
  api.setTooltipEl = (el) => { tipEl = el; };

  function build() {
    container.innerHTML = "";
    svg = d3.select(container).append("svg")
      .attr("width", "100%").attr("height", "100%").style("display", "block");
    const occupiedPattern = svg.append("defs").append("pattern")
      .attr("id", "war-occupied")
      .attr("width", 7).attr("height", 7)
      .attr("patternUnits", "userSpaceOnUse")
      .attr("patternTransform", "rotate(35)");
    occupiedPattern.append("rect").attr("width", 7).attr("height", 7).attr("fill", C.warOccupied);
    occupiedPattern.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 7)
      .attr("stroke", C.paperSoft).attr("stroke-width", 2).attr("opacity", 0.38);
    svg.append("rect").attr("class", "atlas-bg")
      .attr("width", "100%").attr("height", "100%").attr("fill", C.ocean);
    globeG = svg.append("g").attr("class", "globe").style("display", "none");
    camera = svg.append("g").attr("class", "camera").style("transform-origin", "0 0");
    countriesG = camera.append("g").attr("class", "modern-countries");
    historicalG = camera.append("g").attr("class", "historical-territories").style("display", "none");
    historicalLabelsG = camera.append("g").attr("class", "historical-labels")
      .style("display", "none").style("pointer-events", "none");
    overlayG = camera.append("g");

    const interruptCamera = () => svg.interrupt().interrupt("camera");
    zoom = d3.zoom().scaleExtent([1, 14])
      .on("start", (ev) => { if (ev.sourceEvent) interruptCamera(); })
      .on("zoom", (ev) => { currentK = ev.transform.k; camera.attr("transform", ev.transform.toString()); rescale(); });
    svg.call(zoom)
      .on("dblclick.zoom", null)
      .on("wheel.camera-interrupt", interruptCamera, { capture: true, passive: true })
      .on("pointerdown.camera-interrupt", interruptCamera, { capture: true })
      .on("wheel", (e) => e.preventDefault());
  }

  function rescale() {
    overlayG.selectAll("[data-r]").attr("r", function () { return +this.getAttribute("data-r") / currentK; });
    camera.selectAll("[data-fs]").attr("font-size", function () { return (+this.getAttribute("data-fs") / currentK) + "px"; });
    overlayG.selectAll("[data-y0]").attr("y", function () {
      return +this.getAttribute("data-y0") - (+this.getAttribute("data-dy")) / currentK;
    });
  }

  function availableMapFrame() {
    const { w, h } = size;
    const mobile = w <= 820;
    const header = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")) || 72;
    let left = 20, right = w - 20, top = header + 20, bottom = h - 24;
    const bounds = (selector) => {
      const element = document.querySelector(selector);
      if (!element || (mobile && selector === ".rail" && element.closest(".has-sel"))) return null;
      let x = 0, y = 0;
      for (let parent = element; parent && parent !== container.parentElement; parent = parent.offsetParent) {
        x += parent.offsetLeft;
        y += parent.offsetTop;
      }
      return { left: x, top: y, right: x + element.offsetWidth, bottom: y + element.offsetHeight };
    };
    if (view === "guided" || view === "explore") {
      const sheet = bounds(view === "guided" ? ".narr" : ".rail");
      const profile = view === "explore" ? bounds(".panel-host:has(.panel)") : null;
      if (mobile) {
        top = header + (view === "explore" ? (profile ? 68 : 84) : 16);
        if (profile || sheet) bottom = (profile || sheet).top - 16;
      } else {
        if (sheet) left = sheet.right + 24;
        if (profile) right = profile.left - 24;
      }
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
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    size = { w, h };
    mapFrame = availableMapFrame();
    projection = d3.geoEqualEarth().fitExtent([[mapFrame[0], mapFrame[1]], [mapFrame[2], mapFrame[3]]],
      { type: "Sphere" });
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
  }
  api.resize = () => layout(true);

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
    for (const j of store.journeys)
      for (const w of j.waypoints) {
        const p = projection([w.lng, w.lat]);
        w.px = p ? p[0] : null; w.py = p ? p[1] : null;
      }
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

  function closestPathLength(pathNode, target) {
    const total = pathNode.getTotalLength();
    const samples = 120;
    let bestLength = 0;
    let bestDistance = Infinity;
    for (let index = 0; index <= samples; index++) {
      const length = total * index / samples;
      const point = pathNode.getPointAtLength(length);
      const distance = Math.hypot(point.x - target.x, point.y - target.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestLength = length;
      }
    }
    let radius = total / samples;
    for (let iteration = 0; iteration < 5; iteration++) {
      const start = Math.max(0, bestLength - radius);
      const end = Math.min(total, bestLength + radius);
      for (let index = 0; index <= 12; index++) {
        const length = start + (end - start) * index / 12;
        const point = pathNode.getPointAtLength(length);
        const distance = Math.hypot(point.x - target.x, point.y - target.y);
        if (distance < bestDistance) {
          bestDistance = distance;
          bestLength = length;
        }
      }
      radius /= 4;
    }
    return bestLength;
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
    overlayG.selectAll("*").interrupt().interrupt("guided-reveal").remove();
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
    g.append("text").attr("x", x).attr("data-y0", y).attr("data-dy", dy).attr("y", y - dy / currentK)
      .attr("text-anchor", "middle").attr("data-fs", fs).attr("font-size", `${fs / currentK}px`)
      .attr("font-family", "'Public Sans',sans-serif").attr("font-weight", o.weight || 600)
      .attr("letter-spacing", o.ls || "0").attr("fill", o.fill || C.anchorInk)
      .attr("paint-order", o.halo ? "stroke" : null)
      .attr("stroke", o.halo ? C.paperSoft : null)
      .attr("stroke-width", o.halo ? 3 : null)
      .attr("stroke-linejoin", o.halo ? "round" : null)
      .attr("vector-effect", "non-scaling-stroke").text(text);
  }

  function moveCamera(target, k) {
    const centerX = (mapFrame[0] + mapFrame[2]) / 2;
    const centerY = (mapFrame[1] + mapFrame[3]) / 2;
    const t = target
      ? d3.zoomIdentity.translate(centerX - k * target.x, centerY - k * target.y).scale(k)
      : d3.zoomIdentity;
    svg.interrupt("camera");
    const sel = motionEnabled() ? svg.transition("camera").duration(850).ease(d3.easeCubicInOut) : svg;
    sel.call(zoom.transform, t);
  }
  api.resetCamera = () => moveCamera(null, 1);
  function focusJourney(journey) {
    const points = journey.waypoints.filter((point) => point.px != null);
    if (!points.length) { api.resetCamera(); return; }
    const xs = points.map((point) => point.px), ys = points.map((point) => point.py);
    const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
    const scale = Math.min(4, Math.max(1, Math.min(
      (mapFrame[2] - mapFrame[0] - 40) / Math.max(1, x1 - x0),
      (mapFrame[3] - mapFrame[1] - 40) / Math.max(1, y1 - y0),
    )));
    moveCamera({ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }, scale);
  }
  api.zoomBy = (factor) => {
    svg.interrupt("camera");
    const center = [(mapFrame[0] + mapFrame[2]) / 2, (mapFrame[1] + mapFrame[3]) / 2];
    const selection = motionEnabled() ? svg.transition("camera").duration(280).ease(d3.easeCubicOut) : svg;
    selection.call(zoom.scaleBy, factor, center);
  };

  function showTip(e, text) { if (!tipEl) return; tipEl.textContent = text; tipEl.style.opacity = 1; moveTip(e); }
  function moveTip(e) {
    if (!tipEl) return;
    const r = container.getBoundingClientRect();
    tipEl.style.left = (e.clientX - r.left) + "px"; tipEl.style.top = (e.clientY - r.top) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = 0; }

  // ---- choropleth ------------------------------------------------------------
  function paintChoropleth(on) {
    if (!countrySel) return;
    countrySel.interrupt("country-fill")
      .on(".war", null)
      .style("pointer-events", null)
      .attr("data-war-side", null)
      .attr("stroke", C.landStroke)
      .attr("stroke-width", 0.5);
    if (!on) { countrySel.attr("fill", C.land); return; }
    const max = Math.max(1, ...[...store.originCounts.values()]);
    const ramp = d3.interpolateRgb(C.densityLow, C.accentDeep);
    countrySel.attr("fill", (d) => {
      const n = store.originCounts.get(d.properties.name) || 0;
      return n ? ramp(Math.pow(n / max, 0.5)) : C.densityNone;
    });
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

  function ensureHistoricalBoundaries() {
    if (historicalFeatures || historicalPromise) return historicalPromise;
    document.documentElement.dataset.historicalBoundaries = "loading";
    historicalPromise = fetch("data/historical_boundaries.json", { cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Historical boundaries failed to load: ${response.status}`);
        return response.json();
      })
      .then((topology) => {
        if (!topojson?.feature || !topology.objects?.territories) {
          throw new Error("Historical boundary topology is invalid or TopoJSON is unavailable");
        }
        historicalFeatures = topojson.feature(topology, topology.objects.territories).features;
        document.documentElement.dataset.historicalBoundaries = "ready";
        if (api._last) api._last();
        return historicalFeatures;
      })
      .catch((error) => {
        document.documentElement.dataset.historicalBoundaries = "error";
        console.error(error);
        return null;
      });
    return historicalPromise;
  }

  function territoryStatus(feature, period) {
    if (!period) return "neutral";
    const { controller, name, kind } = feature.properties;
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
    const control = controller && controller !== name ? `, administered by ${controller}` : "";
    const type = kind ? `, ${String(kind).replaceAll("_", " ")}` : "";
    const status = territoryStatus(feature, currentTerritoryPeriod);
    const alignment = status === "coalition"
      ? currentTerritoryPeriod?.coalition_label
      : (status === "opposition"
        ? currentTerritoryPeriod?.opposition_label
        : (status === "occupied" ? "occupied / contested" : null));
    return `${name}${control}${type}. Active ${territoryYears(feature)}${alignment ? `. ${alignment}` : ""}`;
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
      ));
  }

  function renderHistoricalLabels(features) {
    const byName = new Map();
    for (const feature of features) {
      const name = feature.properties.name;
      const area = Number(feature.properties.area_km2) || d3.geoArea(feature);
      if (!byName.has(name) || area > byName.get(name).area) byName.set(name, { feature, area });
    }
    const limit = size.w <= 820 ? 0 : 8;
    const labels = [...byName.values()]
      .filter((entry) => entry.area > 120000)
      .sort((a, b) => b.area - a.area)
      .slice(0, limit)
      .map((entry) => {
        const point = path.centroid(entry.feature);
        return { ...entry, x: point[0], y: point[1] };
      })
      .filter((entry) => Number.isFinite(entry.x) && Number.isFinite(entry.y));
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
      .text((entry) => {
        const name = entry.feature.properties.name
          .replace(/^Dominion of /i, "")
          .replace(/^United Kingdom of Great Britain and Ireland$/i, "United Kingdom");
        return name;
      });
  }

  function showHistoricalBoundaries(year, period) {
    currentTerritoryPeriod = period;
    currentBoundaryYear = year;
    if (!historicalFeatures) {
      historicalG.style("display", "none");
      historicalLabelsG.style("display", "none");
      countriesG.style("display", null);
      ensureHistoricalBoundaries();
      return false;
    }
    const instant = year + 0.5;
    const active = historicalFeatures
      .filter((feature) => (
        feature.properties.start <= instant &&
        (feature.properties.end == null || feature.properties.end > instant)
      ))
      .sort((a, b) => Number(a.properties.kind === "occupation") - Number(b.properties.kind === "occupation"));
    document.documentElement.dataset.historicalBoundaries = "ready";
    countriesG.style("display", "none");
    historicalG.style("display", null);
    historicalLabelsG.style("display", null);
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
          pinnedController = pinnedController === controller ? null : controller;
          emphasizeTerritories();
          showTip(event, territoryDescription(feature));
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
      .attr("data-war-side", (feature) => territoryStatus(feature, period));
    emphasizeTerritories();
    renderHistoricalLabels(active);
    return true;
  }

  function hideHistoricalBoundaries() {
    currentTerritoryPeriod = null;
    currentBoundaryYear = null;
    hoveredController = null;
    pinnedController = null;
    historicalG.style("display", "none");
    historicalLabelsG.style("display", "none");
    countriesG.style("display", null);
    document.documentElement.dataset.historicalBoundaries =
      historicalFeatures ? "inactive" : (historicalPromise ? "loading" : "idle");
  }

  function buildGlobeRoutePool() {
    if (!store) { globeRoutePool = []; return; }
    globeRoutePool = store.journeys.map((journey) => {
      const coordinates = [];
      for (const waypoint of journey.waypoints) {
        if (!Number.isFinite(waypoint.lng) || !Number.isFinite(waypoint.lat)) continue;
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
    if (motionEnabled() && now - globeRouteChangedAt > 11000) rotateGlobeRoutes();
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
      const home = j.waypoints[0];
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
    if (!motionEnabled()) { redrawGlobe(); return; }
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
    api._last = (forceFrame = false) => api.render(v, ctx, forceFrame);
    if (!overlayG) return;
    const changed = v !== view; view = v;
    const frame = availableMapFrame();
    const frameChanged = !mapFrame || frame.some((value, index) => value !== mapFrame[index]);
    if (frameChanged) layout();
    // A shared or hidden browser tab can begin with no measurable map area.
    if (!projection) return;
    svg.select(".atlas-bg").attr("fill-opacity", v === "landing" ? 0.12 : 1);
    if (v === "landing") { svg.style("pointer-events", "none"); showGlobe(true); return; }
    showGlobe(false);
    const interactive = v === "explore" || v === "patterns";
    svg.style("pointer-events", interactive ? "auto" : "none");
    const historicalReady = ctx.boundaryYear != null
      ? showHistoricalBoundaries(ctx.boundaryYear, ctx.warPeriod)
      : (hideHistoricalBoundaries(), false);
    if (v === "patterns" && ctx.patternsLayer === "origins") {
      hideHistoricalBoundaries();
      paintChoropleth(true);
    } else if (historicalReady) {
      paintChoropleth(false);
    } else if (ctx.warPeriod) {
      paintWarContext(ctx.warPeriod);
    } else {
      paintChoropleth(false);
    }
    if (v === "guided") {
      if (changed || frameChanged || reframe) clearOverlay();
      drawGuided(frameChanged || reframe ? { ...ctx, prevIndex: null } : ctx);
    } else if (v === "explore") {
      clearOverlay();
      drawExplore(ctx);
      if (changed || frameChanged || reframe || selectedJourney !== ctx.selectedId) {
        const journey = store.byId.get(ctx.selectedId);
        if (journey) focusJourney(journey);
        else api.resetCamera();
      }
      selectedJourney = ctx.selectedId;
    } else if (v === "patterns") {
      clearOverlay();
      drawPatterns(ctx);
      if ((changed || frameChanged || reframe) && !ctx.activePatternEvent) api.resetCamera();
    }
  };

  function drawGuided(ctx) {
    const j = store.byId.get(ctx.guidedId) || store.journeys[0];
    if (!j) return;
    const wp = j.waypoints.filter((w) => w.px != null);
    const idx = Math.min(ctx.guidedIndex || 0, wp.length - 1);
    const g = overlayG;
    const col = GROUP_COLOR[j.group] || C.accent;

    const visible = wp.slice(0, idx + 1);
    const routes = g.selectAll(".guided-route").data(
      visible.length > 1 ? [{ key: j.id, points: visible }] : [],
      (datum) => datum.key,
    );
    const previousNode = routes.empty() ? null : routes.node();
    const previousLength = previousNode ? previousNode.getTotalLength() : 0;
    const previousOffset = previousNode
      ? Number(d3.select(previousNode).attr("stroke-dashoffset")) || 0
      : 0;
    const previousVisibleLength = Math.max(0, Math.min(
      previousLength,
      previousLength - previousOffset,
    ));
    const previousVisiblePoint = previousNode
      ? previousNode.getPointAtLength(previousVisibleLength)
      : null;
    routes.exit().interrupt("guided-reveal").remove();
    const enteredRoutes = routes.enter().append("path")
      .attr("class", "guided-route")
      .attr("fill", "none")
      .attr("vector-effect", "non-scaling-stroke")
      .attr("stroke-linecap", "round")
      .attr("stroke-linejoin", "round");
    enteredRoutes.merge(routes).each(function (datum) {
      const selection = d3.select(this).interrupt("guided-reveal")
        .attr("stroke-dasharray", null)
        .attr("stroke-dashoffset", null)
        .attr("d", journeyPath(datum.points))
      .attr("stroke", col)
      .attr("stroke-width", 2.4)
      .attr("opacity", 0.92);
      const animate = ctx.prevIndex != null && ctx.prevIndex < idx && motionEnabled();
      if (!animate) return;
      const length = this.getTotalLength();
      const revealed = previousVisiblePoint
        ? closestPathLength(this, previousVisiblePoint)
        : 0;
      selection.attr("stroke-dasharray", length).attr("stroke-dashoffset", length - revealed)
        .transition("guided-reveal").duration(900).ease(d3.easeCubicInOut)
        .attr("stroke-dashoffset", 0)
        .on("end", () => selection.attr("stroke-dasharray", null).attr("stroke-dashoffset", null));
    });

    const ring = wp[idx] ? [{ ...wp[idx], key: `${j.id}-${idx}` }] : [];
    g.selectAll(".guided-ring").data(ring, (d) => d.key).join(
      (enter) => enter.append("circle").attr("class", "guided-ring")
        .attr("fill", "none").attr("vector-effect", "non-scaling-stroke"),
      (update) => update,
      (exit) => exit.remove(),
    )
      .attr("cx", (d) => d.px).attr("cy", (d) => d.py)
      .attr("data-r", 9).attr("r", 9 / currentK)
      .attr("stroke", col).attr("stroke-width", 1.5).attr("opacity", 0.4);

    const points = wp.map((point, i) => ({
      ...point,
      key: `${j.id}-${i}`,
      active: i === idx,
      visited: i <= idx,
    }));
    g.selectAll(".guided-point").data(points, (d) => d.key).join(
      (enter) => enter.append("circle").attr("class", "guided-point"),
      (update) => update,
      (exit) => exit.remove(),
    )
      .attr("cx", (d) => d.px).attr("cy", (d) => d.py)
      .attr("data-r", (d) => d.active ? 5 : 3.4)
      .attr("r", (d) => (d.active ? 5 : 3.4) / currentK)
      .attr("fill", (d) => d.visited ? col : C.dotIdle)
      .attr("opacity", (d) => d.visited ? 0.85 : 0.55);

    if (wp[idx]) moveCamera({ x: wp[idx].px, y: wp[idx].py }, 3.2);
  }

  function drawExplore(ctx) {
    const g = overlayG;
    const sel = store.byId.get(ctx.selectedId);
    const visible = ctx.matches || (() => true);
    if (sel) {
      const wp = sel.waypoints.filter((w) => w.px != null);
      const col = GROUP_COLOR[sel.group] || C.accent;
      route(g, wp, {
        className: "explore-route",
        color: col,
        width: 2.2,
        op: 0.9,
        animate: true,
      });
      wp.forEach((w) => {
        dot(g, w.px, w.py, { r: 3.6, fill: col });
        if (w.liberation || w.newLife) dot(g, w.px, w.py, { r: 8, fill: "none", stroke: col, sw: 1.2, op: 0.35 });
      });
    }
    for (const j of store.journeys) {
      const home = j.waypoints[0];
      if (!home || home.px == null) continue;
      const isSel = sel && j.id === sel.id;
      const col = GROUP_COLOR[j.group] || C.accent;
      const dim = visible(j) ? 1 : 0.1;
      const c = dot(g, home.px, home.py, {
        r: isSel ? 6 : 4, fill: isSel ? col : C.paperSoft, stroke: isSel ? C.accentDeep : col,
        sw: isSel ? 2 : 1.4, op: dim,
      });
      c.style("cursor", "pointer").attr("pointer-events", "all")
        .on("click", () => ctx.onSelect && ctx.onSelect(j.id))
        .on("mouseenter", (e) => showTip(e, `${j.name}, ${j.hometown || j.group}`))
        .on("mousemove", (e) => moveTip(e)).on("mouseleave", hideTip);
    }
  }

  function drawPatterns(ctx) {
    const g = overlayG;
    if (ctx.patternsLayer === "origins") { drawOrigins(g); return; }
    const activeEvent = ctx.activePatternEvent;
    const activeIds = new Set(activeEvent?.people.slice(0, 4).map((person) => person.id) || []);
    const activeConflict = ctx.warPeriod?.archive_conflict;

    const corridors = activeConflict
      ? (store.veteranCorridors.get(activeConflict) || []).filter((corridor) => corridor.count > 1).slice(0, 8)
      : [];
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
      const waypoints = journey.waypoints.filter((waypoint) => waypoint.px != null);
      if (waypoints.length < 2) continue;
      g.append("path")
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
    const rankedEvents = [...(ctx.patternEvents || [])]
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
        .attr("role", "button")
        .attr("tabindex", 0)
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
    if (activePoint) moveCamera(activePoint, size.w <= 820 ? 1.1 : 1.18);
  }

  function drawOrigins(g) {
    const placed = new Map();
    for (const j of store.journeys) {
      const home = j.waypoints[0]; if (!home || home.px == null || !j.originCountry) continue;
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

  // ---- mini route (side panel) ----------------------------------------------
  api.drawMini = function (svgEl, j) {
    if (!svgEl || !j) return;
    const sel = d3.select(svgEl); sel.selectAll("*").remove();
    const W = 340, H = 150, pad = 22;
    const pts = j.waypoints.filter((w) => w.px != null).map((w) => ({ px: w.px, py: w.py, newLife: w.newLife }));
    if (pts.length < 1) return;
    const xs = pts.map((p) => p.px), ys = pts.map((p) => p.py);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const sx = (maxx - minx) || 1, sy = (maxy - miny) || 1;
    const k = Math.min((W - pad * 2) / sx, (H - pad * 2) / sy);
    const ox = (W - sx * k) / 2 - minx * k, oy = (H - sy * k) / 2 - miny * k;
    const P = pts.map((p) => ({ x: p.px * k + ox, y: p.py * k + oy, newLife: p.newLife }));
    const col = GROUP_COLOR[j.group] || C.accent;
    sel.append("path").attr("d", journeyPath(P))
      .attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.6)
      .attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    P.forEach((p, i) => sel.append("circle").attr("cx", p.x).attr("cy", p.y)
      .attr("r", i === 0 || i === P.length - 1 ? 4 : 2.8).attr("fill", p.newLife ? C.anchorInk : col));
  };

  return api;
}
