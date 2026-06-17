// TIME SCRUBBER (doc 01 "the centerpiece", F10).
// Drag across ~1933–1950 and every survivor's dot moves to where they were that year,
// tracing along their journey. Pause on 1944 and watch dots converge on Auschwitz.
// Fuzzy testimony dates are shown as a soft, larger halo — never false precision.
import { PALETTE, TIME, REDUCED_MOTION } from "./config.js";

export function createScrubber(ctx) {
  const { map, store } = ctx;
  const layer = L.layerGroup();
  const dots = new Map(); // survivor_id -> marker
  let year = TIME.min;
  let active = false;

  // Mirror of pipeline/dates.year_span so positions match the build exactly.
  function span(d) {
    const yr = (t) => {
      const m = String(t || "").match(/(1[89]\d\d|20\d\d)/);
      return m ? parseInt(m[1], 10) : null;
    };
    let s = yr(d && d.start), e = yr(d && d.end);
    if (e === null) e = s;
    if (s === null) s = e;
    if (s !== null && e !== null && e < s) [s, e] = [e, s];
    return [s, e];
  }

  // Where is this survivor in year Y? Returns {lat,lng,fuzzy,present,label}.
  function positionAt(s, Y) {
    const pts = s.waypoints.map((w) => {
      const [a, b] = span(w.date);
      return { ...w, y0: a, y1: b };
    });
    const dated = pts.filter((p) => p.y0 !== null);
    if (!dated.length) return { present: false };

    const here = dated.filter((p) => p.y0 <= Y && Y <= p.y1);
    if (here.length) {
      const p = here[here.length - 1]; // most recent arrival wins
      return { lat: p.lat, lng: p.lng, present: true, label: p.as_written,
               fuzzy: p.date.precision === "range" || here.length > 1 };
    }
    const before = dated.filter((p) => p.y1 < Y).slice(-1)[0];
    const after = dated.find((p) => p.y0 > Y);
    if (before && after) {
      const f = (Y - before.y1) / (after.y0 - before.y1 || 1);
      return {
        lat: before.lat + (after.lat - before.lat) * f,
        lng: before.lng + (after.lng - before.lng) * f,
        present: true, fuzzy: true, label: "in transit",
      };
    }
    if (!before && after) return { present: false }; // not yet on the map
    if (before && !after)
      return { lat: before.lat, lng: before.lng, present: true, fuzzy: false, label: before.as_written };
    return { present: false };
  }

  function update() {
    let presentCount = 0;
    for (const s of store.survivors) {
      const pos = positionAt(s, year);
      let m = dots.get(s.survivor_id);
      if (!pos.present) {
        if (m) { layer.removeLayer(m); dots.delete(s.survivor_id); }
        continue;
      }
      presentCount++;
      const size = pos.fuzzy ? 12 : 8;
      const opacity = pos.fuzzy ? 0.45 : 0.9;
      if (!m) {
        m = L.circleMarker([pos.lat, pos.lng], {});
        m.bindTooltip(s.name, { direction: "top", opacity: 0.9 });
        dots.set(s.survivor_id, m);
        layer.addLayer(m);
      }
      m.setLatLng([pos.lat, pos.lng]);
      m.setStyle({
        radius: size,
        color: PALETTE.active,
        weight: pos.fuzzy ? 1 : 1.5,
        fillColor: PALETTE.active,
        fillOpacity: opacity,
        className: pos.fuzzy ? "ohp-fuzzy" : "",
      });
      m.setTooltipContent(`${s.name} — ${pos.label} (${year})`);
    }
    if (ctx.scrubberEl) {
      ctx.scrubberEl.querySelector("[data-year]").textContent = year;
      ctx.scrubberEl.querySelector("[data-count]").textContent =
        `${presentCount} survivor${presentCount === 1 ? "" : "s"} placed`;
    }
  }

  function render() {
    ctx.scrubberEl.innerHTML = `
      <div class="scrubber" role="group" aria-label="Time scrubber">
        <button class="link-btn" data-step="-1" aria-label="Previous year">‹</button>
        <label class="scrub-label">
          <span class="scrub-year" data-year>${year}</span>
          <input type="range" min="${TIME.min}" max="${TIME.max}" step="1" value="${year}"
                 aria-label="Year, ${TIME.min} to ${TIME.max}">
        </label>
        <button class="link-btn" data-step="1" aria-label="Next year">›</button>
        <span class="scrub-count muted small" data-count></span>
      </div>`;
    const input = ctx.scrubberEl.querySelector("input");
    input.addEventListener("input", () => { year = +input.value; update(); });
    ctx.scrubberEl.querySelectorAll("[data-step]").forEach((b) =>
      b.addEventListener("click", () => {
        year = Math.min(TIME.max, Math.max(TIME.min, year + +b.dataset.step));
        input.value = year;
        update();
      })
    );
  }

  function activate() {
    active = true;
    ctx.scrubberEl.hidden = false;
    map.addLayer(layer);
    render();
    update();
  }

  function deactivate() {
    active = false;
    ctx.scrubberEl.hidden = true;
    ctx.scrubberEl.innerHTML = "";
    layer.clearLayers();
    dots.clear();
    map.removeLayer(layer);
  }

  return { activate, deactivate, isActive: () => active };
}
