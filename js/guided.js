// GUIDED MODE — scrollytelling (doc 01 mode 1, F8).
// A narrated walk through ONE survivor's journey. As the visitor scrolls, the map
// pans and the route draws itself one leg at a time (SnakeAnim), teaching the visual
// language before handing over control. Built on Scrollama (IntersectionObserver).
import { PALETTE, REDUCED_MOTION, ROLE_LABELS } from "./config.js";
import { dotIcon, fitTo } from "./mapcore.js";

export function createGuided(ctx) {
  const { map, store } = ctx;
  // Prefer a featured survivor with a rich, dated arc; fall back gracefully.
  const survivor =
    store.byId.get("baranek-martin") ||
    store.featured.find((s) => s.waypoints.length >= 4) ||
    store.featured[0] ||
    store.survivors[0];
  let layer = L.layerGroup();
  let scroller = null;
  let drawn = [];

  function activate() {
    map.addLayer(layer);
    renderSteps();
    const home = survivor.waypoints[0];
    map.flyTo([home.lat, home.lng], 6, { animate: !REDUCED_MOTION, duration: REDUCED_MOTION ? 0 : 0.6 });
    initScrollama();
  }

  function deactivate() {
    if (scroller) scroller.destroy();
    scroller = null;
    layer.clearLayers();
    map.removeLayer(layer);
    drawn = [];
  }

  function renderSteps() {
    const steps = survivor.waypoints
      .map((wp, i) => {
        return `<section class="step" data-step="${i}">
          <p class="step-date">${esc(dateLabel(wp.date))}</p>
          <h3>${ROLE_LABELS[wp.role] || wp.role}: ${esc(wp.as_written)}</h3>
          <p class="muted small">${esc(wp.canonical)}</p>
          ${wp.source_quote ? `<blockquote>${esc(wp.source_quote)}</blockquote>` : ""}
        </section>`;
      })
      .join("");

    ctx.panel.innerHTML = `
      <div class="guided">
        <section class="step step-intro" data-step="-1">
          <h2>${esc(survivor.name)}</h2>
          <p class="lede">${esc(survivor.bio_excerpt || "")}</p>
          <p class="muted small">Scroll to follow the journey. Each stop is a place in a
            life; the line is the path between them.</p>
          ${statusLine(survivor)}
        </section>
        ${steps}
        <section class="step step-outro">
          <p>That was one journey. Switch to <strong>Explore</strong> to see all
            ${store.survivors.length}, or <strong>Patterns</strong> to see where they cross.</p>
          <p><a class="archive" href="${esc(survivor.archive_url)}" target="_blank" rel="noopener">Full archive entry ↗</a></p>
        </section>
      </div>`;
  }

  function reveal(index) {
    // Show waypoints 0..index and draw legs up to index.
    layer.clearLayers();
    drawn = [];
    for (let i = 0; i <= index; i++) {
      const wp = survivor.waypoints[i];
      const isLast = i === index;
      layer.addLayer(
        L.marker([wp.lat, wp.lng], {
          icon: dotIcon(isLast ? PALETTE.active : PALETTE.journey, isLast ? 10 : 6),
          keyboard: false,
          title: `${wp.as_written} — ${ROLE_LABELS[wp.role] || wp.role}`,
        })
      );
      if (i > 0) {
        const seg = [
          [survivor.waypoints[i - 1].lat, survivor.waypoints[i - 1].lng],
          [wp.lat, wp.lng],
        ];
        const line = L.polyline(seg, { color: PALETTE.journey, weight: 2.5, opacity: 0.9 });
        layer.addLayer(line);
        // Animate only the newest leg; older legs are already in place.
        if (isLast && !REDUCED_MOTION && typeof line.snakeIn === "function") {
          line.setLatLngs([seg[0]]); // start collapsed
          line.setLatLngs(seg);
          line.snakeIn ? line.snakeIn() : null;
        }
      }
    }
    const revealed = survivor.waypoints.slice(0, index + 1).map((w) => [w.lat, w.lng]);
    if (revealed.length === 1) {
      map.flyTo(revealed[0], 6, { animate: !REDUCED_MOTION, duration: REDUCED_MOTION ? 0 : 0.6 });
    } else {
      fitTo(map, L.latLngBounds(revealed));
    }
  }

  function initScrollama() {
    if (typeof scrollama !== "function") return; // graceful: steps still readable
    scroller = scrollama();
    scroller
      .setup({
        step: `#${ctx.panel.id} .step`,
        offset: 0.6,
        // duplicate observer for accuracy on resize
      })
      .onStepEnter((res) => {
        const idx = parseInt(res.element.dataset.step, 10);
        if (Number.isInteger(idx) && idx >= 0) reveal(idx);
        res.element.classList.add("is-active");
      })
      .onStepExit((res) => res.element.classList.remove("is-active"));
    // initial draw of birthplace
    reveal(0);
  }

  return { activate, deactivate };
}

function dateLabel(d) {
  if (!d || (!d.start && !d.end)) return "date uncertain";
  if (d.start === d.end || !d.end) return d.start || "—";
  return `${d.start}–${d.end}`;
}
function statusLine(s) {
  if (s.is_sample)
    return '<p class="sample-flag">Illustrative sample record — not real testimony.</p>';
  if (s.review_status === "pending")
    return '<p class="sample-flag">Drawn from this survivor\'s public archive summary — ' +
      'approximate and pending verification &amp; permission.</p>';
  return "";
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
