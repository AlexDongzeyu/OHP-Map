// The landing hero: a quiet, data-drawn backdrop of the real journeys.
// Faint ember journey lines converging across Europe — dignified, not decorative.
// One static draw (optionally a slow one-time reveal), reduced-motion honoured.
import { PALETTE, REDUCED_MOTION } from "./config.js";

// Europe-ish viewport in lng/lat; a simple equirectangular projection is plenty here.
const VIEW = { west: -10, east: 36, south: 34, north: 60 };

export function drawHero(canvas, store) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

  function project(lng, lat, w, h) {
    const x = ((lng - VIEW.west) / (VIEW.east - VIEW.west)) * w;
    const y = (1 - (lat - VIEW.south) / (VIEW.north - VIEW.south)) * h;
    return [x, y];
  }

  // Keep only journeys with >=2 European waypoints, capped for a calm density.
  const journeys = [];
  for (const s of store.survivors) {
    const pts = s.waypoints
      .filter((w) => w.lng >= VIEW.west && w.lng <= VIEW.east &&
                     w.lat >= VIEW.south && w.lat <= VIEW.north)
      .map((w) => [w.lng, w.lat]);
    if (pts.length >= 2) journeys.push(pts);
  }
  // Featured first, then a sample of the rest, so the hero isn't a solid smear.
  const featuredIds = new Set(store.featured.map((s) => s.survivor_id));
  const ordered = store.survivors
    .filter((s) => featuredIds.has(s.survivor_id))
    .concat(store.survivors.filter((s) => !featuredIds.has(s.survivor_id)));
  void ordered; // (journeys already built; kept for clarity of intent)

  const sample = journeys.filter((_, i) => i % 1 === 0).slice(0, 120);

  function render(progress = 1) {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth || canvas.parentElement.clientWidth || 1200;
    const h = canvas.clientHeight || canvas.parentElement.clientHeight || 700;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Faint journey lines.
    ctx.lineWidth = 1;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    for (let j = 0; j < sample.length; j++) {
      const pts = sample[j];
      const reveal = Math.max(0, Math.min(1, progress * 1.4 - j / sample.length * 0.4));
      if (reveal <= 0) continue;
      ctx.strokeStyle = hexA(PALETTE.journey, 0.10);
      ctx.beginPath();
      const last = Math.max(1, Math.floor((pts.length - 1) * reveal) + 1);
      for (let i = 0; i < last; i++) {
        const [x, y] = project(pts[i][0], pts[i][1], w, h);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    // Quiet origin dots.
    for (const s of store.survivors) {
      const home = s.waypoints.find((wp) => wp.role === "birthplace") || s.waypoints[0];
      if (!home) continue;
      if (home.lng < VIEW.west || home.lng > VIEW.east ||
          home.lat < VIEW.south || home.lat > VIEW.north) continue;
      const [x, y] = project(home.lng, home.lat, w, h);
      ctx.fillStyle = hexA(PALETTE.ink, 0.14 * progress);
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  if (REDUCED_MOTION) {
    render(1);
  } else {
    // A single slow reveal — never loops.
    const start = performance.now();
    const dur = 2200;
    (function frame(now) {
      const p = Math.min(1, (now - start) / dur);
      render(easeOut(p));
      if (p < 1) requestAnimationFrame(frame);
    })(start);
  }

  // Redraw on resize (debounced).
  let t;
  window.addEventListener("resize", () => {
    clearTimeout(t);
    t = setTimeout(() => render(1), 150);
  });
}

function easeOut(p) { return 1 - Math.pow(1 - p, 3); }

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
