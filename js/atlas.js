// atlas.js — the map engine.
//
// Two stages share one SVG:
//   • a slow-rotating 3D globe (d3.geoOrthographic) for the LANDING — a clean
//     establishing shot of the world (doc 08: gentle 3D overview only).
//   • a flat, paper-toned vector map of Europe for GUIDED / EXPLORE / PATTERNS, with
//     curved self-drawing journey arcs, an off-map "new life across the Atlantic"
//     anchor, an optional origin-density CHOROPLETH, and FREE pan/zoom (d3.zoom).
//
// The 2D map is the canonical product; the globe is enhancement with a graceful path.
import { C, REDUCED_MOTION } from "./config.js";

const d3 = window.d3;

export function createAtlas(container) {
  let europe = null, worldGlobe = null;
  let svg, globeG, camera, countriesG, overlayG, countrySel = null;
  let projection, path;          // flat Europe
  let gProjection, gPath;        // globe
  let size = { w: 0, h: 0 }, currentK = 1, anchor = { x: 0, y: 0 };
  let store = null, tipEl = null, zoom = null;
  let view = null, rotateRAF = null, rot = [ -14, -48, 0 ];
  const api = {};

  const EUROPE = { type: "MultiPoint", coordinates: [[-11, 34], [40, 34], [40, 61], [-11, 61]] };

  api.ready = (async function init() {
    const [eu, gl] = await Promise.all([
      fetch("data/atlas-europe.json", { cache: "force-cache" }).then((r) => r.json()),
      fetch("data/atlas-world.json", { cache: "force-cache" }).then((r) => r.json()).catch(() => null),
    ]);
    europe = eu; worldGlobe = gl;
    build();
    layout();
    return api;
  })();

  api.setStore = (s) => { store = s; };
  api.setTooltipEl = (el) => { tipEl = el; };

  // ---- build -----------------------------------------------------------------
  function build() {
    container.innerHTML = "";
    svg = d3.select(container).append("svg")
      .attr("width", "100%").attr("height", "100%").style("display", "block");
    svg.append("rect").attr("width", "100%").attr("height", "100%").attr("fill", C.ocean);

    globeG = svg.append("g").attr("class", "globe").style("display", "none");
    camera = svg.append("g").attr("class", "camera").style("transform-origin", "0 0");
    countriesG = camera.append("g");
    overlayG = camera.append("g");

    zoom = d3.zoom().scaleExtent([1, 9])
      .on("zoom", (ev) => {
        currentK = ev.transform.k;
        camera.attr("transform", ev.transform.toString());
        rescaleMarkers();
      });
    svg.call(zoom).on("dblclick.zoom", null).on("wheel", (e) => e.preventDefault());
  }

  function rescaleMarkers() {
    overlayG.selectAll("[data-r]").attr("r", function () { return +this.getAttribute("data-r") / currentK; });
    overlayG.selectAll("[data-fs]").attr("font-size", function () { return (+this.getAttribute("data-fs") / currentK) + "px"; });
    overlayG.selectAll("[data-y]").attr("y", function () {
      return +this.getAttribute("data-y0") - (+this.getAttribute("data-y")) / currentK;
    });
  }

  // ---- layout ----------------------------------------------------------------
  function layout(redraw) {
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    size = { w, h };
    projection = d3.geoMercator().fitExtent(
      [[Math.max(40, w * 0.05), h * 0.06], [w - 40, h - 40]], EUROPE);
    path = d3.geoPath(projection);
    anchor = { x: Math.max(70, w * 0.085), y: h * 0.6 };

    const land = countriesG.selectAll("path").data(europe.features);
    countrySel = land.enter().append("path").merge(land)
      .attr("d", path).attr("fill", C.land)
      .attr("stroke", C.landStroke).attr("stroke-width", 0.6)
      .attr("vector-effect", "non-scaling-stroke");
    land.exit().remove();

    layoutGlobe();
    if (store) projectAll();
    if (redraw && api._last) api._last();
  }
  api.resize = () => layout(true);

  function layoutGlobe() {
    if (!worldGlobe) return;
    const { w, h } = size;
    const r = Math.min(w, h) * 0.46;
    gProjection = d3.geoOrthographic().scale(r)
      .translate([w * (w > 720 ? 0.6 : 0.5), h * 0.46]).rotate(rot).clipAngle(90);
    gPath = d3.geoPath(gProjection);
  }

  // ---- projection of waypoints ----------------------------------------------
  function projectWaypoint(w) {
    if (w.overseas) return { x: anchor.x, y: anchor.y, off: true };
    const p = projection([w.lng, w.lat]);
    if (!p) return { x: anchor.x, y: anchor.y, off: true };
    return { x: p[0], y: p[1], off: false };
  }
  function projectAll() {
    for (const j of store.journeys)
      for (const w of j.waypoints) { const p = projectWaypoint(w); w.px = p.x; w.py = p.y; w.off = p.off; }
  }

  function legPath(a, b) {
    const dx = b.px - a.px, dy = b.py - a.py;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len, ny = dx / len;
    const off = Math.min(len * 0.16, 70);
    const cx = (a.px + b.px) / 2 + nx * off, cy = (a.py + b.py) / 2 + ny * off;
    return `M${a.px},${a.py} Q${cx},${cy} ${b.px},${b.py}`;
  }

  api.pointAtYear = function (j, year) {
    const wps = j.waypoints.filter((w) => w.year != null);
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

  // ---- low-level draw --------------------------------------------------------
  function clearOverlay() { overlayG.selectAll("*").remove(); }

  function dot(g, x, y, o = {}) {
    const r = o.r || 4;
    return g.append("circle").attr("cx", x).attr("cy", y)
      .attr("data-r", r).attr("r", r / currentK)
      .attr("fill", o.fill || C.dotIdle).attr("stroke", o.stroke || "none")
      .attr("stroke-width", (o.sw || 0)).attr("vector-effect", "non-scaling-stroke")
      .attr("opacity", o.op == null ? 1 : o.op);
  }

  function leg(g, a, b, o = {}) {
    const p = g.append("path").attr("d", legPath(a, b)).attr("fill", "none")
      .attr("stroke", o.color || C.accent).attr("stroke-width", o.width || 2)
      .attr("vector-effect", "non-scaling-stroke").attr("stroke-linecap", "round")
      .attr("opacity", o.op == null ? 1 : o.op);
    if (o.animate && !REDUCED_MOTION) {
      const len = p.node().getTotalLength();
      p.attr("stroke-dasharray", len).attr("stroke-dashoffset", len)
        .transition().duration(900).ease(d3.easeCubicInOut).attr("stroke-dashoffset", 0);
    }
    return p;
  }

  function label(g, x, y, text, o = {}) {
    const fs = o.fs || 11, dy = o.dy || 0;
    g.append("text").attr("x", x).attr("data-y0", y).attr("data-y", dy).attr("y", y - dy / currentK)
      .attr("text-anchor", "middle").attr("data-fs", fs).attr("font-size", `${fs / currentK}px`)
      .attr("font-family", "'Public Sans',sans-serif").attr("font-weight", o.weight || 600)
      .attr("letter-spacing", o.ls || "0.12em").attr("fill", o.fill || C.anchorInk).text(text);
  }

  function anchorLabel(g, show) {
    if (!show) return;
    dot(g, anchor.x, anchor.y, { r: 5, fill: C.anchorInk });
    dot(g, anchor.x, anchor.y, { r: 10, fill: "none", stroke: C.anchorInk, sw: 1, op: 0.25 });
    label(g, anchor.x, anchor.y, "NEW LIFE", { fs: 11, dy: 16 });
    label(g, anchor.x, anchor.y, "across the Atlantic", { fs: 9, dy: -20, weight: 400, ls: "0", fill: C.faint });
  }

  // ---- camera ----------------------------------------------------------------
  function moveCamera(target, k) {
    const { w, h } = size;
    const t = target
      ? d3.zoomIdentity.translate(w / 2 - k * target.x, h / 2 - k * target.y).scale(k)
      : d3.zoomIdentity;
    const sel = REDUCED_MOTION ? svg : svg.transition().duration(850).ease(d3.easeCubicInOut);
    sel.call(zoom.transform, t);
  }
  api.resetCamera = () => moveCamera(null, 1);

  // ---- tooltip ---------------------------------------------------------------
  function showTip(e, text) { if (!tipEl) return; tipEl.textContent = text; tipEl.style.opacity = 1; moveTip(e); }
  function moveTip(e) {
    if (!tipEl) return;
    const r = container.getBoundingClientRect();
    tipEl.style.left = (e.clientX - r.left) + "px";
    tipEl.style.top = (e.clientY - r.top) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = 0; }

  // ---- choropleth ------------------------------------------------------------
  function paintChoropleth(on) {
    if (!countrySel) return;
    if (!on) { countrySel.attr("fill", C.land); return; }
    const max = Math.max(1, ...[...store.originCounts.values()]);
    const ramp = d3.interpolateRgb("#EEE6D6", C.accentDeep);
    countrySel.attr("fill", (d) => {
      const n = store.originCounts.get(d.properties.name) || 0;
      if (!n) return "#EFEADF";
      return ramp(Math.pow(n / max, 0.55));
    });
  }

  // ---- globe -----------------------------------------------------------------
  function showGlobe(on) {
    globeG.style("display", on ? null : "none");
    camera.style("display", on ? "none" : null);
    if (on) drawGlobe(), startRotate();
    else stopRotate();
  }

  function drawGlobe() {
    if (!worldGlobe) { showGlobe(false); return; }
    globeG.selectAll("*").remove();
    const c = gProjection.translate();
    const r = gProjection.scale();
    globeG.append("circle").attr("cx", c[0]).attr("cy", c[1]).attr("r", r)
      .attr("fill", "#F2EDE3").attr("stroke", C.landStroke).attr("stroke-width", 1);
    const land = globeG.append("g");
    land.selectAll("path").data(worldGlobe.features).enter().append("path")
      .attr("fill", "#E3DCCC").attr("stroke", "#D6CDBB").attr("stroke-width", 0.4);
    const dots = globeG.append("g");
    redrawGlobe(land, dots);
    globeG._land = land; globeG._dots = dots;
  }

  function redrawGlobe(land, dots) {
    land = land || globeG._land; dots = dots || globeG._dots;
    if (!land) return;
    gProjection.rotate(rot);
    land.selectAll("path").attr("d", gPath);
    // origin dots on the visible hemisphere
    const center = [-rot[0], -rot[1]];
    const data = store ? store.journeys : [];
    const sel = dots.selectAll("circle").data(data, (j) => j.id);
    sel.enter().append("circle").attr("r", 1.7).attr("fill", C.accent).merge(sel)
      .each(function (j) {
        const home = j.waypoints[0];
        if (!home) { d3.select(this).attr("display", "none"); return; }
        const visible = d3.geoDistance([home.lng, home.lat], center) < Math.PI / 2;
        if (!visible) { d3.select(this).attr("display", "none"); return; }
        const p = gProjection([home.lng, home.lat]);
        d3.select(this).attr("display", null).attr("cx", p[0]).attr("cy", p[1]).attr("opacity", 0.55);
      });
    sel.exit().remove();
  }

  function startRotate() {
    stopRotate();
    if (REDUCED_MOTION) { rot = [-14, -48, 0]; layoutGlobe(); redrawGlobe(); return; }
    const step = () => { rot[0] += 0.16; redrawGlobe(); rotateRAF = requestAnimationFrame(step); };
    rotateRAF = requestAnimationFrame(step);
  }
  function stopRotate() { if (rotateRAF) cancelAnimationFrame(rotateRAF); rotateRAF = null; }

  // ---- per-view rendering ----------------------------------------------------
  api.render = function (v, ctx) {
    api._last = () => api.render(v, ctx);
    if (!overlayG) return;
    const changed = v !== view; view = v;

    if (v === "landing") {
      svg.style("pointer-events", "none");
      showGlobe(true);
      return;
    }
    showGlobe(false);
    const interactive = v === "explore" || v === "patterns";
    svg.style("pointer-events", interactive ? "auto" : "none");

    // Choropleth only in patterns "origins" layer.
    paintChoropleth(v === "patterns" && ctx.patternsLayer === "origins");

    clearOverlay();
    if (v === "guided") drawGuided(ctx);
    else if (v === "explore") { drawExplore(ctx); if (changed) api.resetCamera(); }
    else if (v === "patterns") { drawPatterns(ctx); if (changed) api.resetCamera(); }
  };

  function drawGuided(ctx) {
    const j = store.byId.get(ctx.guidedId) || store.journeys[0];
    if (!j) return;
    const idx = Math.min(ctx.guidedIndex || 0, j.waypoints.length - 1);
    const g = overlayG;
    for (let i = 0; i < idx; i++) {
      const newest = i === idx - 1;
      const animate = newest && ctx.prevIndex != null && ctx.prevIndex < idx;
      leg(g, j.waypoints[i], j.waypoints[i + 1], { color: C.accent, width: 2.4, op: 0.92, animate });
    }
    j.waypoints.forEach((w, i) => {
      const active = i === idx, visited = i <= idx;
      if (active) {
        dot(g, w.px, w.py, { r: 9, fill: "none", stroke: C.accent, sw: 1.5, op: 0.4 });
        dot(g, w.px, w.py, { r: 5, fill: C.accent });
      } else dot(g, w.px, w.py, { r: 3.4, fill: visited ? C.accent : C.dotIdle, op: visited ? 0.85 : 0.55 });
    });
    const t = j.waypoints[idx];
    moveCamera({ x: t.px, y: t.py }, 2.2);
    anchorLabel(g, j.waypoints.some((w) => w.overseas) && idx >= j.waypoints.length - 1);
  }

  function drawExplore(ctx) {
    const g = overlayG;
    const theme = ctx.theme, q = (ctx.query || "").toLowerCase();
    const sel = store.byId.get(ctx.selectedId);
    const matches = (j) => (!theme || j.themes.includes(theme)) &&
      (!q || (j.name + " " + j.hometown + " " + j.themes.join(" ") + " " +
        j.waypoints.map((w) => w.canonical + " " + w.asWritten).join(" ")).toLowerCase().includes(q));
    if (sel) {
      for (let i = 0; i < sel.waypoints.length - 1; i++)
        leg(g, sel.waypoints[i], sel.waypoints[i + 1], { color: C.accent, width: 2.2, op: 0.9, animate: true });
      sel.waypoints.forEach((w) => {
        dot(g, w.px, w.py, { r: 3.6, fill: C.accent });
        if (w.liberation || w.overseas) dot(g, w.px, w.py, { r: 8, fill: "none", stroke: C.accent, sw: 1.2, op: 0.35 });
      });
    }
    for (const j of store.journeys) {
      const home = j.waypoints[0]; if (!home) continue;
      const isSel = sel && j.id === sel.id;
      const dim = matches(j) ? 1 : 0.14;
      const c = dot(g, home.px, home.py, {
        r: isSel ? 6 : 4.5, fill: isSel ? C.accent : C.paperSoft,
        stroke: isSel ? C.accentDeep : C.accent, sw: isSel ? 2 : 1.5, op: dim,
      });
      c.style("cursor", "pointer").attr("pointer-events", "all")
        .on("click", () => ctx.onSelect && ctx.onSelect(j.id))
        .on("mouseenter", (e) => showTip(e, `${j.name} · ${j.hometown}`))
        .on("mousemove", (e) => moveTip(e))
        .on("mouseleave", hideTip);
    }
    anchorLabel(g, true);
  }

  function drawPatterns(ctx) {
    const g = overlayG;
    if (ctx.patternsLayer === "origins") { drawOrigins(g); return; }
    const year = ctx.scrubYear;
    for (const j of store.journeys)
      for (let i = 0; i < j.waypoints.length - 1; i++)
        leg(g, j.waypoints[i], j.waypoints[i + 1], { color: C.accent, width: 1.2, op: 0.1 });
    for (const sp of store.shared.slice(0, 6)) {
      const w0 = findWaypoint(sp.canonical); if (!w0) continue;
      dot(g, w0.px, w0.py, { r: 13, fill: "none", stroke: C.accent, sw: 1.1, op: 0.5 });
      dot(g, w0.px, w0.py, { r: 8, fill: "none", stroke: C.accent, sw: 1, op: 0.3 });
    }
    for (const j of store.journeys) {
      const pos = api.pointAtYear(j, year); if (!pos) continue;
      if (pos.glow) {
        dot(g, pos.x, pos.y, { r: 11, fill: C.accent, op: 0.13 });
        dot(g, pos.x, pos.y, { r: 6, fill: C.accent, op: 0.26 });
      }
      dot(g, pos.x, pos.y, { r: 3.6, fill: pos.before ? C.dotIdle : C.accent, stroke: C.paperSoft, sw: 1, op: pos.before ? 0.6 : 1 });
    }
    anchorLabel(g, true);
  }

  // Origin density: choropleth is painted on the countries; here we add count labels.
  function drawOrigins(g) {
    const placed = new Map();
    for (const j of store.journeys) {
      const home = j.waypoints[0]; if (!home || home.off) continue;
      if (!placed.has(j.originCountry)) placed.set(j.originCountry, { x: 0, y: 0, n: 0 });
      const e = placed.get(j.originCountry); e.x += home.px; e.y += home.py; e.n++;
    }
    for (const [country, e] of placed) {
      const n = store.originCounts.get(country) || e.n;
      if (n < 3) continue;
      const cx = e.x / e.n, cy = e.y / e.n;
      dot(g, cx, cy, { r: 3, fill: C.accentDeep, op: 0.8 });
      label(g, cx, cy, `${n}`, { fs: 13, dy: 10, weight: 600, ls: "0", fill: C.accentDeep });
    }
    anchorLabel(g, false);
  }

  function findWaypoint(canonical) {
    for (const j of store.journeys) for (const w of j.waypoints) if (w.canonical === canonical) return w;
    return null;
  }

  // ---- mini route (side panel) ----------------------------------------------
  api.drawMini = function (svgEl, j) {
    if (!svgEl || !j) return;
    const sel = d3.select(svgEl); sel.selectAll("*").remove();
    const W = 340, H = 150, pad = 22;
    const pts = j.waypoints.map((w) => ({ px: w.px, py: w.py, newLife: w.overseas || w.newLife }));
    const xs = pts.map((p) => p.px), ys = pts.map((p) => p.py);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const sx = (maxx - minx) || 1, sy = (maxy - miny) || 1;
    const k = Math.min((W - pad * 2) / sx, (H - pad * 2) / sy);
    const ox = (W - sx * k) / 2 - minx * k, oy = (H - sy * k) / 2 - miny * k;
    const P = pts.map((p) => ({ x: p.px * k + ox, y: p.py * k + oy, newLife: p.newLife }));
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, off = Math.min(len * 0.16, 18);
      const cx = (a.x + b.x) / 2 + nx * off, cy = (a.y + b.y) / 2 + ny * off;
      sel.append("path").attr("d", `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`)
        .attr("fill", "none").attr("stroke", C.accent).attr("stroke-width", 1.6).attr("stroke-linecap", "round");
    }
    P.forEach((p, i) => sel.append("circle").attr("cx", p.x).attr("cy", p.y)
      .attr("r", i === 0 || i === P.length - 1 ? 4 : 2.8).attr("fill", p.newLife ? C.anchorInk : C.accent));
  };

  return api;
}
