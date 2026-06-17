// PATTERNS MODE (doc 01 mode 3, F9) — the aggregate lens.
// Flow lines (common routes as weighted lines), origin density (where survivors came
// from), and the connection layer (verified "same place, same time" overlaps). This
// is the view that reveals what 200 alphabetical entries hide.
import { PALETTE } from "./config.js";

export function createPatterns(ctx) {
  const { map, store } = ctx;
  const flows = L.layerGroup();
  const density = L.layerGroup();
  const links = L.layerGroup();
  const focus = L.layerGroup();
  let show = { flows: true, density: true, links: true };

  function build() {
    buildFlows();
    buildDensity();
    buildLinks();
  }

  function buildFlows() {
    const agg = new Map(); // "a|b" -> { a, b, count, coords }
    for (const s of store.survivors) {
      for (let i = 0; i < s.waypoints.length - 1; i++) {
        const a = s.waypoints[i];
        const b = s.waypoints[i + 1];
        if (a.canonical === b.canonical) continue;
        const key = a.canonical + "|" + b.canonical;
        if (!agg.has(key))
          agg.set(key, { count: 0, coords: [[a.lat, a.lng], [b.lat, b.lng]] });
        agg.get(key).count++;
      }
    }
    for (const { count, coords } of agg.values()) {
      flows.addLayer(
        L.polyline(coords, {
          color: PALETTE.flow,
          weight: 1.5 + count * 1.5, // thicker = more journeys through this leg
          opacity: 0.5,
          lineCap: "round",
        })
      );
    }
  }

  function buildDensity() {
    const counts = new Map(); // canonical -> { count, lat, lng }
    for (const s of store.survivors) {
      const home = s.waypoints.find((w) => w.role === "birthplace") || s.waypoints[0];
      if (!home) continue;
      if (!counts.has(home.canonical))
        counts.set(home.canonical, { count: 0, lat: home.lat, lng: home.lng });
      counts.get(home.canonical).count++;
    }
    for (const [, c] of counts) {
      density.addLayer(
        L.circleMarker([c.lat, c.lng], {
          radius: 6 + c.count * 4,
          color: PALETTE.muted,
          weight: 1,
          fillColor: PALETTE.muted,
          fillOpacity: 0.18,
        })
      );
    }
  }

  function buildLinks() {
    for (const c of store.connections) {
      const a = store.byId.get(c.survivorA);
      const b = store.byId.get(c.survivorB);
      if (!a || !b) continue;
      const ha = a.waypoints.find((w) => w.role === "birthplace") || a.waypoints[0];
      const hb = b.waypoints.find((w) => w.role === "birthplace") || b.waypoints[0];
      const line = L.polyline([[ha.lat, ha.lng], [hb.lat, hb.lng]], {
        color: PALETTE.link,
        weight: 1.2,
        opacity: 0.6,
        dashArray: "3 6",
      });
      line._conn = c;
      links.addLayer(line);
    }
  }

  function activate() {
    build();
    if (show.flows) map.addLayer(flows);
    if (show.density) map.addLayer(density);
    if (show.links) map.addLayer(links);
    map.addLayer(focus);
    renderPanel();
  }

  function deactivate() {
    [flows, density, links, focus].forEach((l) => {
      l.clearLayers();
      map.removeLayer(l);
    });
  }

  function toggle(name, on) {
    show[name] = on;
    const layer = { flows, density, links }[name];
    if (on) map.addLayer(layer);
    else map.removeLayer(layer);
  }

  function focusConnection(c) {
    focus.clearLayers();
    const a = store.byId.get(c.survivorA);
    const b = store.byId.get(c.survivorB);
    const place = [...store.places.values()].find((p) => p.canonical === c.place);
    if (place)
      focus.addLayer(
        L.circleMarker([place.lat, place.lng], {
          radius: 12, color: PALETTE.active, weight: 2, fill: false,
        })
      );
    for (const s of [a, b]) {
      if (!s) continue;
      const home = s.waypoints.find((w) => w.role === "birthplace") || s.waypoints[0];
      if (place)
        focus.addLayer(
          L.polyline([[home.lat, home.lng], [place.lat, place.lng]], {
            color: PALETTE.active, weight: 2, opacity: 0.9,
          })
        );
    }
  }

  function renderPanel() {
    ctx.panel.innerHTML = `
      <div class="patterns">
        <h2>Patterns</h2>
        <p class="muted small">The view from above: routes, origins, and the moments two
          journeys cross.</p>
        <fieldset class="toggles">
          <legend>Layers</legend>
          <label><input type="checkbox" data-layer="flows" checked> Flow lines (shared routes)</label>
          <label><input type="checkbox" data-layer="density" checked> Origin density</label>
          <label><input type="checkbox" data-layer="links" checked> Connection layer</label>
        </fieldset>
        <h3>Verified connections <span class="muted">(${store.connections.length})</span></h3>
        <ul class="conns">
          ${store.connections
            .map(
              (c, i) => `<li><button class="link-btn" data-conn="${i}">
              ${esc(nameOf(c.survivorA))} &amp; ${esc(nameOf(c.survivorB))}</button>
              <span class="muted small">— ${esc(c.place.split(" (")[0])}, ${esc(c.overlap_window)}</span></li>`
            )
            .join("")}
        </ul>
        <p class="muted small">Connections are only shown when both testimonies place the
          two people together in time. Phrasing stays careful — "both describe being at X".</p>
      </div>`;
    ctx.panel.querySelectorAll("[data-layer]").forEach((cb) =>
      cb.addEventListener("change", () => toggle(cb.dataset.layer, cb.checked))
    );
    ctx.panel.querySelectorAll("[data-conn]").forEach((b) =>
      b.addEventListener("click", () => focusConnection(store.connections[+b.dataset.conn]))
    );
  }

  function nameOf(id) {
    return store.byId.get(id)?.name || id;
  }

  return { activate, deactivate };
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
