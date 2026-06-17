// atlas.js — the vector map engine: a quiet, paper-toned map of Europe drawn with D3
// + a trimmed TopoJSON-derived GeoJSON. Journeys are curved arcs that draw themselves;
// a CSS-transform camera pans and zooms cinematically; places across the Atlantic are
// drawn as an off-map "new life" anchor. This replaces the old Leaflet basemap.
import { C, REDUCED_MOTION } from "./config.js";

const d3 = window.d3;

export function createAtlas(container) {
  let world = null, svg, camera, countriesG, overlayG, projection, path;
  let size = { w: 0, h: 0 };
  let cameraK = 1;
  let anchor = { x: 0, y: 0 };
  let tipEl = null;
  let store = null;
  const api = {};

  // Europe window matches data/atlas-europe.json's build window.
  const EUROPE = { type: "MultiPoint", coordinates: [[-11, 34], [40, 34], [40, 61], [-11, 61]] };

  api.ready = (async function init() {
    const res = await fetch("data/atlas-europe.json", { cache: "force-cache" });
    if (!res.ok) throw new Error("atlas basemap failed to load");
    world = await res.json();
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
    svg.append("rect").attr("x", 0).attr("y", 0)
      .attr("width", "100%").attr("height", "100%").attr("fill", C.ocean);
    camera = svg.append("g").attr("class", "camera")
      .style("transition", REDUCED_MOTION ? "none" : "transform 850ms cubic-bezier(.4,0,.2,1)")
      .style("transform-origin", "0 0");
    countriesG = camera.append("g");
    overlayG = camera.append("g");
  }

  function layout(redraw) {
    if (!container) return;
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    size = { w, h };
    projection = d3.geoMercator().fitExtent(
      [[Math.max(40, w * 0.05), h * 0.06], [w - 40, h - 40]], EUROPE);
    path = d3.geoPath(projection);
    // "New life across the Atlantic" anchor — lower-left, in the ocean off Europe.
    anchor = { x: Math.max(70, w * 0.085), y: h * 0.6 };

    const land = countriesG.selectAll("path").data(world.features);
    land.enter().append("path").merge(land)
      .attr("d", path).attr("fill", C.land)
      .attr("stroke", C.landStroke).attr("stroke-width", 0.6)
      .attr("vector-effect", "non-scaling-stroke");
    land.exit().remove();

    if (store) projectAll();
    if (redraw && api._lastRender) api._lastRender();
  }

  api.resize = () => layout(true);

  // ---- projection of journey waypoints --------------------------------------
  function projectWaypoint(w) {
    if (w.overseas) return { ...anchor, off: true };
    const p = projection([w.lng, w.lat]);
    if (!p || p[0] < -20 || p[0] > size.w + 20 || p[1] < -20 || p[1] > size.h + 20) {
      // Off the European frame and not flagged overseas → soft-clamp to anchor.
      return { ...anchor, off: true };
    }
    return { x: p[0], y: p[1], off: false };
  }

  function projectAll() {
    for (const j of store.journeys)
      for (const w of j.waypoints) {
        const p = projectWaypoint(w);
        w.px = p.x; w.py = p.y; w.off = p.off;
      }
  }

  // ---- geometry --------------------------------------------------------------
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
  function camG() { return overlayG; }
  function clearOverlay() { overlayG.selectAll("*").remove(); }

  function dot(g, x, y, o = {}) {
    return g.append("circle").attr("cx", x).attr("cy", y).attr("r", (o.r || 4) / cameraK)
      .attr("fill", o.fill || C.dotIdle).attr("stroke", o.stroke || "none")
      .attr("stroke-width", (o.sw || 0) / cameraK).attr("opacity", o.op == null ? 1 : o.op);
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

  function setCamera(target, k) {
    cameraK = k;
    const { w, h } = size;
    let tx, ty;
    if (target) { tx = w / 2 - k * target.x; ty = h / 2 - k * target.y; }
    else { tx = w / 2 - k * (w / 2); ty = h / 2 - k * (h / 2); }
    camera.style("transform", `translate(${tx}px,${ty}px) scale(${k})`);
  }

  function anchorLabel(g, show, text) {
    if (!show) return;
    const t = anchor;
    dot(g, t.x, t.y, { r: 5, fill: C.anchorInk });
    dot(g, t.x, t.y, { r: 10, fill: "none", stroke: C.anchorInk, sw: 1, op: 0.25 });
    g.append("text").attr("x", t.x).attr("y", t.y - 16 / cameraK).attr("text-anchor", "middle")
      .attr("font-family", "'Public Sans',sans-serif").attr("font-size", `${11 / cameraK}px`)
      .attr("font-weight", 600).attr("letter-spacing", "0.12em").attr("fill", C.anchorInk)
      .text(text || "NEW LIFE");
    g.append("text").attr("x", t.x).attr("y", t.y + 20 / cameraK).attr("text-anchor", "middle")
      .attr("font-family", "'Public Sans',sans-serif").attr("font-size", `${9 / cameraK}px`)
      .attr("fill", C.faint).text("across the Atlantic");
  }

  // ---- tooltip ---------------------------------------------------------------
  function showTip(e, text) { if (!tipEl) return; tipEl.textContent = text; tipEl.style.opacity = 1; moveTip(e); }
  function moveTip(e) {
    if (!tipEl) return;
    const r = container.getBoundingClientRect();
    tipEl.style.left = (e.clientX - r.left) + "px";
    tipEl.style.top = (e.clientY - r.top) + "px";
  }
  function hideTip() { if (tipEl) tipEl.style.opacity = 0; }

  // ---- per-view rendering ----------------------------------------------------
  api.render = function (view, ctx) {
    api._lastRender = () => api.render(view, ctx);
    if (!overlayG) return;
    const interactive = view === "explore" || view === "patterns";
    svg.style("pointer-events", interactive ? "auto" : "none");
    clearOverlay();
    if (view === "landing") { drawLanding(); setCamera(null, 1.04); }
    else if (view === "guided") drawGuided(ctx);
    else if (view === "explore") { drawExplore(ctx); setCamera(null, 1); }
    else if (view === "patterns") { drawPatterns(ctx); setCamera(null, 1); }
    else setCamera(null, 1);
  };

  function drawLanding() {
    const g = camG();
    const sample = (store.featured.length ? store.featured : store.journeys).slice(0, 18);
    for (const j of sample) {
      const w = j.waypoints;
      for (let i = 0; i < w.length - 1; i++) leg(g, w[i], w[i + 1], { color: C.accent, width: 1.4, op: 0.16 });
      w.forEach((p) => dot(g, p.px, p.py, { r: 2.4, fill: C.accent, op: 0.26 }));
    }
    anchorLabel(g, true);
  }

  function drawGuided(ctx) {
    const j = store.byId.get(ctx.guidedId) || store.journeys[0];
    if (!j) return;
    const idx = Math.min(ctx.guidedIndex || 0, j.waypoints.length - 1);
    const g = camG();
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
      } else {
        dot(g, w.px, w.py, { r: 3.4, fill: visited ? C.accent : C.dotIdle, op: visited ? 0.85 : 0.55 });
      }
    });
    const t = j.waypoints[idx];
    setCamera({ x: t.px, y: t.py }, 2.2);
    anchorLabel(g, j.waypoints.some((w) => w.overseas) && idx >= j.waypoints.length - 1);
  }

  function drawExplore(ctx) {
    const g = camG();
    const theme = ctx.theme;
    const sel = store.byId.get(ctx.selectedId);
    if (sel) {
      for (let i = 0; i < sel.waypoints.length - 1; i++)
        leg(g, sel.waypoints[i], sel.waypoints[i + 1], { color: C.accent, width: 2.2, op: 0.9, animate: true });
      sel.waypoints.forEach((w) => {
        dot(g, w.px, w.py, { r: 3.6, fill: C.accent });
        if (w.liberation || w.overseas) dot(g, w.px, w.py, { r: 8, fill: "none", stroke: C.accent, sw: 1.2, op: 0.35 });
      });
    }
    for (const j of store.journeys) {
      const match = !theme || j.themes.includes(theme);
      const isSel = sel && j.id === sel.id;
      const home = j.waypoints[0];
      if (!home) continue;
      const dim = theme && !match ? 0.18 : 1;
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
    const g = camG();
    const year = ctx.scrubYear;
    for (const j of store.journeys)
      for (let i = 0; i < j.waypoints.length - 1; i++)
        leg(g, j.waypoints[i], j.waypoints[i + 1], { color: C.accent, width: 1.2, op: 0.1 });
    // Shared-place rings (top crossings).
    for (const sp of store.shared.slice(0, 6)) {
      const w0 = findWaypoint(sp.canonical);
      if (!w0) continue;
      dot(g, w0.px, w0.py, { r: 13, fill: "none", stroke: C.accent, sw: 1.1, op: 0.5 });
      dot(g, w0.px, w0.py, { r: 8, fill: "none", stroke: C.accent, sw: 1, op: 0.3 });
    }
    // Moving dots at the chosen year.
    for (const j of store.journeys) {
      const pos = api.pointAtYear(j, year);
      if (!pos) continue;
      if (pos.glow) {
        dot(g, pos.x, pos.y, { r: 11, fill: C.accent, op: 0.13 });
        dot(g, pos.x, pos.y, { r: 6, fill: C.accent, op: 0.26 });
      }
      dot(g, pos.x, pos.y, {
        r: 3.6, fill: pos.before ? C.dotIdle : C.accent,
        stroke: C.paperSoft, sw: 1, op: pos.before ? 0.6 : 1,
      });
    }
    anchorLabel(g, true);
  }

  function findWaypoint(canonical) {
    for (const j of store.journeys)
      for (const w of j.waypoints) if (w.canonical === canonical) return w;
    return null;
  }

  // ---- mini route (side panel) ----------------------------------------------
  api.drawMini = function (svgEl, j) {
    if (!svgEl || !j) return;
    const sel = d3.select(svgEl);
    sel.selectAll("*").remove();
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
      .attr("r", i === 0 || i === P.length - 1 ? 4 : 2.8)
      .attr("fill", p.newLife ? C.anchorInk : C.accent));
  };

  return api;
}
