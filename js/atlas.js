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
import { C, GROUP_COLOR, REDUCED_MOTION } from "./config.js";

const d3 = window.d3;

export function createAtlas(container) {
  let world = null;
  let svg, globeG, camera, countriesG, overlayG, countrySel = null;
  let projection, path, gProjection, gPath;
  let size = { w: 0, h: 0 }, currentK = 1;
  let store = null, tipEl = null, zoom = null;
  let view = null, rotateRAF = null, rot = [-40, -32, 0];
  const api = {};

  api.ready = (async function init() {
    world = await fetch("data/atlas-world.json", { cache: "force-cache" }).then((r) => r.json());
    build();
    layout();
    return api;
  })();

  api.setStore = (s) => { store = s; };
  api.setTooltipEl = (el) => { tipEl = el; };

  function build() {
    container.innerHTML = "";
    svg = d3.select(container).append("svg")
      .attr("width", "100%").attr("height", "100%").style("display", "block");
    svg.append("rect").attr("width", "100%").attr("height", "100%").attr("fill", C.ocean);
    globeG = svg.append("g").attr("class", "globe").style("display", "none");
    camera = svg.append("g").attr("class", "camera").style("transform-origin", "0 0");
    countriesG = camera.append("g");
    overlayG = camera.append("g");

    zoom = d3.zoom().scaleExtent([1, 14])
      .on("zoom", (ev) => { currentK = ev.transform.k; camera.attr("transform", ev.transform.toString()); rescale(); });
    svg.call(zoom).on("dblclick.zoom", null).on("wheel", (e) => e.preventDefault());
  }

  function rescale() {
    overlayG.selectAll("[data-r]").attr("r", function () { return +this.getAttribute("data-r") / currentK; });
    overlayG.selectAll("[data-fs]").attr("font-size", function () { return (+this.getAttribute("data-fs") / currentK) + "px"; });
    overlayG.selectAll("[data-y0]").attr("y", function () {
      return +this.getAttribute("data-y0") - (+this.getAttribute("data-dy")) / currentK;
    });
  }

  // World projection fitted to the populated band (North America → Korea).
  function layout(redraw) {
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    size = { w, h };
    projection = d3.geoEqualEarth().fitExtent([[24, 24], [w - 24, h - 24]],
      { type: "MultiPoint", coordinates: [[-128, 56], [-118, 40], [142, 36], [128, 38], [-78, 36], [22, 60], [16, 36]] });
    path = d3.geoPath(projection);

    const land = countriesG.selectAll("path").data(world.features);
    countrySel = land.enter().append("path").merge(land)
      .attr("d", path).attr("fill", C.land)
      .attr("stroke", C.landStroke).attr("stroke-width", 0.5)
      .attr("vector-effect", "non-scaling-stroke");
    land.exit().remove();

    layoutGlobe();
    if (store) projectAll();
    if (redraw && api._last) api._last();
  }
  api.resize = () => layout(true);

  function layoutGlobe() {
    const { w, h } = size;
    const r = Math.min(w, h) * 0.46;
    gProjection = d3.geoOrthographic().scale(r)
      .translate([w * (w > 720 ? 0.58 : 0.5), h * 0.46]).rotate(rot).clipAngle(90);
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
  function clearOverlay() { overlayG.selectAll("*").remove(); }
  function dot(g, x, y, o = {}) {
    const r = o.r || 4;
    return g.append("circle").attr("cx", x).attr("cy", y).attr("data-r", r).attr("r", r / currentK)
      .attr("fill", o.fill || C.dotIdle).attr("stroke", o.stroke || "none")
      .attr("stroke-width", o.sw || 0).attr("vector-effect", "non-scaling-stroke")
      .attr("opacity", o.op == null ? 1 : o.op);
  }
  function leg(g, a, b, o = {}) {
    if (a.px == null || b.px == null) return null;
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
    g.append("text").attr("x", x).attr("data-y0", y).attr("data-dy", dy).attr("y", y - dy / currentK)
      .attr("text-anchor", "middle").attr("data-fs", fs).attr("font-size", `${fs / currentK}px`)
      .attr("font-family", "'Public Sans',sans-serif").attr("font-weight", o.weight || 600)
      .attr("letter-spacing", o.ls || "0").attr("fill", o.fill || C.anchorInk).text(text);
  }

  function moveCamera(target, k) {
    const { w, h } = size;
    const t = target
      ? d3.zoomIdentity.translate(w / 2 - k * target.x, h / 2 - k * target.y).scale(k)
      : d3.zoomIdentity;
    const sel = REDUCED_MOTION ? svg : svg.transition().duration(850).ease(d3.easeCubicInOut);
    sel.call(zoom.transform, t);
  }
  api.resetCamera = () => moveCamera(null, 1);

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
    if (!on) { countrySel.attr("fill", C.land); return; }
    const max = Math.max(1, ...[...store.originCounts.values()]);
    const ramp = d3.interpolateRgb("#EEE6D6", C.accentDeep);
    countrySel.attr("fill", (d) => {
      const n = store.originCounts.get(d.properties.name) || 0;
      return n ? ramp(Math.pow(n / max, 0.5)) : "#EFEADF";
    });
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
    globeG.append("circle").attr("cx", c[0]).attr("cy", c[1]).attr("r", r)
      .attr("fill", "#F2EDE3").attr("stroke", C.landStroke).attr("stroke-width", 1);
    const land = globeG.append("g");
    land.selectAll("path").data(world.features).enter().append("path")
      .attr("fill", "#E3DCCC").attr("stroke", "#D6CDBB").attr("stroke-width", 0.4);
    const dots = globeG.append("g");
    globeG._land = land; globeG._dots = dots;
    redrawGlobe();
  }
  function redrawGlobe() {
    const land = globeG._land, dots = globeG._dots;
    if (!land) return;
    gProjection.rotate(rot);
    land.selectAll("path").attr("d", gPath);
    const center = [-rot[0], -rot[1]];
    const sel = dots.selectAll("circle").data(store ? store.journeys : [], (j) => j.id);
    sel.enter().append("circle").attr("r", 1.6).merge(sel).each(function (j) {
      const home = j.waypoints[0];
      if (!home) { d3.select(this).attr("display", "none"); return; }
      const vis = d3.geoDistance([home.lng, home.lat], center) < Math.PI / 2;
      if (!vis) { d3.select(this).attr("display", "none"); return; }
      const p = gProjection([home.lng, home.lat]);
      d3.select(this).attr("display", null).attr("cx", p[0]).attr("cy", p[1])
        .attr("fill", GROUP_COLOR[j.group] || C.accent).attr("opacity", 0.5);
    });
    sel.exit().remove();
  }
  function startRotate() {
    stopRotate();
    if (REDUCED_MOTION) { redrawGlobe(); return; }
    const step = () => { rot[0] += 0.14; redrawGlobe(); rotateRAF = requestAnimationFrame(step); };
    rotateRAF = requestAnimationFrame(step);
  }
  function stopRotate() { if (rotateRAF) cancelAnimationFrame(rotateRAF); rotateRAF = null; }

  // ---- per-view rendering ----------------------------------------------------
  api.render = function (v, ctx) {
    api._last = () => api.render(v, ctx);
    if (!overlayG) return;
    const changed = v !== view; view = v;
    if (v === "landing") { svg.style("pointer-events", "none"); showGlobe(true); return; }
    showGlobe(false);
    const interactive = v === "explore" || v === "patterns";
    svg.style("pointer-events", interactive ? "auto" : "none");
    paintChoropleth(v === "patterns" && ctx.patternsLayer === "origins");
    clearOverlay();
    if (v === "guided") drawGuided(ctx);
    else if (v === "explore") { drawExplore(ctx); if (changed) api.resetCamera(); }
    else if (v === "patterns") { drawPatterns(ctx); if (changed) api.resetCamera(); }
  };

  function drawGuided(ctx) {
    const j = store.byId.get(ctx.guidedId) || store.journeys[0];
    if (!j) return;
    const wp = j.waypoints.filter((w) => w.px != null);
    const idx = Math.min(ctx.guidedIndex || 0, wp.length - 1);
    const g = overlayG;
    const col = GROUP_COLOR[j.group] || C.accent;
    for (let i = 0; i < idx; i++) {
      const animate = i === idx - 1 && ctx.prevIndex != null && ctx.prevIndex < idx;
      leg(g, wp[i], wp[i + 1], { color: col, width: 2.4, op: 0.92, animate });
    }
    wp.forEach((w, i) => {
      const active = i === idx, visited = i <= idx;
      if (active) {
        dot(g, w.px, w.py, { r: 9, fill: "none", stroke: col, sw: 1.5, op: 0.4 });
        dot(g, w.px, w.py, { r: 5, fill: col });
      } else dot(g, w.px, w.py, { r: 3.4, fill: visited ? col : C.dotIdle, op: visited ? 0.85 : 0.55 });
    });
    if (wp[idx]) moveCamera({ x: wp[idx].px, y: wp[idx].py }, 3.2);
  }

  function drawExplore(ctx) {
    const g = overlayG;
    const sel = store.byId.get(ctx.selectedId);
    const visible = ctx.matches || (() => true);
    if (sel) {
      const wp = sel.waypoints.filter((w) => w.px != null);
      const col = GROUP_COLOR[sel.group] || C.accent;
      for (let i = 0; i < wp.length - 1; i++) leg(g, wp[i], wp[i + 1], { color: col, width: 2.2, op: 0.9, animate: true });
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
        .on("mouseenter", (e) => showTip(e, `${j.name} · ${j.hometown || j.group}`))
        .on("mousemove", (e) => moveTip(e)).on("mouseleave", hideTip);
    }
  }

  function drawPatterns(ctx) {
    const g = overlayG;
    if (ctx.patternsLayer === "origins") { drawOrigins(g); return; }
    // One faint path per journey (keeps thousands of legs cheap).
    for (const j of store.journeys) {
      const wp = j.waypoints.filter((w) => w.px != null);
      if (wp.length < 2) continue;
      let d = `M${wp[0].px},${wp[0].py}`;
      for (let i = 1; i < wp.length; i++) d += `L${wp[i].px},${wp[i].py}`;
      g.append("path").attr("d", d).attr("fill", "none").attr("stroke", GROUP_COLOR[j.group] || C.accent)
        .attr("stroke-width", 0.8).attr("vector-effect", "non-scaling-stroke").attr("opacity", 0.08);
    }
    for (const sp of store.shared.slice(0, 8)) {
      const w0 = findWaypoint(sp.canonical); if (!w0 || w0.px == null) continue;
      dot(g, w0.px, w0.py, { r: 12, fill: "none", stroke: C.accent, sw: 1.1, op: 0.5 });
      dot(g, w0.px, w0.py, { r: 7, fill: "none", stroke: C.accent, sw: 1, op: 0.3 });
    }
    const year = ctx.scrubYear;
    for (const j of store.journeys) {
      const pos = api.pointAtYear(j, year); if (!pos) continue;
      const col = GROUP_COLOR[j.group] || C.accent;
      if (pos.glow) { dot(g, pos.x, pos.y, { r: 10, fill: col, op: 0.12 }); dot(g, pos.x, pos.y, { r: 6, fill: col, op: 0.24 }); }
      dot(g, pos.x, pos.y, { r: 3.2, fill: pos.before ? C.dotIdle : col, stroke: C.paperSoft, sw: 0.8, op: pos.before ? 0.55 : 1 });
    }
  }

  function drawOrigins(g) {
    const placed = new Map();
    for (const j of store.journeys) {
      const home = j.waypoints[0]; if (!home || home.px == null || !j.originCountry) continue;
      if (!placed.has(j.originCountry)) placed.set(j.originCountry, { x: 0, y: 0, n: 0 });
      const e = placed.get(j.originCountry); e.x += home.px; e.y += home.py; e.n++;
    }
    for (const [country, e] of placed) {
      const n = store.originCounts.get(country) || e.n;
      if (n < 3) continue;
      const cx = e.x / e.n, cy = e.y / e.n;
      dot(g, cx, cy, { r: 3, fill: C.accentDeep, op: 0.85 });
      label(g, cx, cy, `${n}`, { fs: 12, dy: 10, weight: 600, fill: C.accentDeep });
    }
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
    const pts = j.waypoints.filter((w) => w.px != null).map((w) => ({ px: w.px, py: w.py, newLife: w.newLife }));
    if (pts.length < 1) return;
    const xs = pts.map((p) => p.px), ys = pts.map((p) => p.py);
    const minx = Math.min(...xs), maxx = Math.max(...xs), miny = Math.min(...ys), maxy = Math.max(...ys);
    const sx = (maxx - minx) || 1, sy = (maxy - miny) || 1;
    const k = Math.min((W - pad * 2) / sx, (H - pad * 2) / sy);
    const ox = (W - sx * k) / 2 - minx * k, oy = (H - sy * k) / 2 - miny * k;
    const P = pts.map((p) => ({ x: p.px * k + ox, y: p.py * k + oy, newLife: p.newLife }));
    const col = GROUP_COLOR[j.group] || C.accent;
    for (let i = 0; i < P.length - 1; i++) {
      const a = P[i], b = P[i + 1];
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      const nx = -dy / len, ny = dx / len, off = Math.min(len * 0.16, 18);
      const cx = (a.x + b.x) / 2 + nx * off, cy = (a.y + b.y) / 2 + ny * off;
      sel.append("path").attr("d", `M${a.x},${a.y} Q${cx},${cy} ${b.x},${b.y}`)
        .attr("fill", "none").attr("stroke", col).attr("stroke-width", 1.6).attr("stroke-linecap", "round");
    }
    P.forEach((p, i) => sel.append("circle").attr("cx", p.x).attr("cy", p.y)
      .attr("r", i === 0 || i === P.length - 1 ? 4 : 2.8).attr("fill", p.newLife ? C.anchorInk : col));
  };

  return api;
}
