// EXPLORE MODE (doc 01 mode 2, F4–F7, F11).
// Every survivor is a clustered dot at their hometown. Click a survivor for a side
// panel; click a place to highlight everyone connected to it; filter with the bar
// that replaces the archive's broken search.
import { PALETTE, ROLE_LABELS, country } from "./config.js";
import { survivorMarker, journeyLine, waypointMarkers, dotIcon, fitTo } from "./mapcore.js";

export function createExplore(ctx) {
  const { map, store } = ctx;
  let cluster = null;
  let markers = new Map(); // survivor_id -> marker
  let highlightLayer = L.layerGroup();
  let selectedId = null;
  let filter = { camp: "", origin: "", tag: "", text: "" };

  function activate() {
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      spiderfyOnMaxZoom: true,
    });
    for (const s of store.survivors) {
      const m = survivorMarker(s);
      m.on("click keypress", () => selectSurvivor(s.survivor_id, true));
      markers.set(s.survivor_id, m);
      cluster.addLayer(m);
    }
    map.addLayer(cluster);
    map.addLayer(highlightLayer);
    renderPanel();
  }

  function deactivate() {
    if (cluster) map.removeLayer(cluster);
    highlightLayer.clearLayers();
    map.removeLayer(highlightLayer);
    markers = new Map();
    selectedId = null;
  }

  function passesFilter(s) {
    const f = filter;
    if (f.camp && !s.waypoints.some((w) => w.canonical === f.camp)) return false;
    if (f.origin) {
      const home = s.waypoints.find((w) => w.role === "birthplace");
      if (!home || country(home.canonical) !== f.origin) return false;
    }
    if (f.tag && !(s.theme_tags || []).includes(f.tag)) return false;
    if (f.text) {
      const hay = (
        s.name + " " + (s.bio_excerpt || "") + " " +
        s.waypoints.map((w) => w.as_written + " " + w.canonical).join(" ")
      ).toLowerCase();
      if (!hay.includes(f.text.toLowerCase())) return false;
    }
    return true;
  }

  function applyFilter() {
    if (!cluster) return;
    cluster.clearLayers();
    const visible = store.survivors.filter(passesFilter);
    for (const s of visible) cluster.addLayer(markers.get(s.survivor_id));
    renderResults(visible);
  }

  // ---- selection -------------------------------------------------------------

  function selectSurvivor(id, fly = false) {
    selectedId = id;
    highlightLayer.clearLayers();
    const s = store.byId.get(id);
    if (!s) return;
    const line = journeyLine(s, PALETTE.active);
    highlightLayer.addLayer(line);
    waypointMarkers(s, (wp) => selectPlace(store.places.get(wp.canonical)?.slug)).forEach(
      (m) => highlightLayer.addLayer(m)
    );
    if (fly) fitTo(map, line);
    renderDetail(s);
    ctx.setHash(`#/survivor/${id}`);
  }

  function selectPlace(placeSlug, fly = false) {
    const place = store.placeBySlug.get(placeSlug);
    if (!place) return;
    selectedId = null;
    highlightLayer.clearLayers();
    const ids = store.placeIndex[place.canonical] || [];
    // Pulse the place, and highlight each connected survivor's home dot.
    highlightLayer.addLayer(
      L.circleMarker([place.lat, place.lng], {
        radius: 14, color: PALETTE.active, weight: 2, fill: false, className: "ohp-place-ring",
      })
    );
    for (const id of ids) {
      const s = store.byId.get(id);
      const home = s.waypoints.find((w) => w.role === "birthplace") || s.waypoints[0];
      highlightLayer.addLayer(
        L.polyline([[home.lat, home.lng], [place.lat, place.lng]], {
          color: PALETTE.link, weight: 1.5, opacity: 0.7, dashArray: "4 5",
        })
      );
    }
    if (fly) fitTo(map, L.latLng(place.lat, place.lng) && highlightLayer);
    renderPlaceDetail(place, ids);
    ctx.setHash(`#/place/${place.slug}`);
  }

  // ---- panel rendering -------------------------------------------------------

  function renderPanel() {
    const f = store.facets;
    ctx.panel.innerHTML = `
      <form class="filterbar" aria-label="Filter survivors">
        <label>Camp / ghetto
          <select name="camp">${opt("All", "", f.camps)}</select></label>
        <label>Origin country
          <select name="origin">${opt("All", "", f.origins)}</select></label>
        <label>Theme
          <select name="tag">${opt("All", "", f.tags)}</select></label>
        <label>Search
          <input name="text" type="search" placeholder="name or place…" autocomplete="off"></label>
        <button type="button" class="link-btn" data-reset>Reset</button>
      </form>
      <div class="results" role="list" aria-label="Survivors"></div>
      <div class="detail" aria-live="polite"></div>`;

    const form = ctx.panel.querySelector(".filterbar");
    form.addEventListener("input", (e) => {
      const t = e.target;
      if (t.name in filter) {
        filter[t.name] = t.value;
        applyFilter();
      }
    });
    form.querySelector("[data-reset]").addEventListener("click", () => {
      filter = { camp: "", origin: "", tag: "", text: "" };
      form.reset();
      applyFilter();
    });
    applyFilter();
  }

  function renderResults(visible) {
    const box = ctx.panel.querySelector(".results");
    if (!box) return;
    box.innerHTML =
      `<p class="muted small">${visible.length} of ${store.survivors.length} shown</p>` +
      visible
        .map(
          (s) => `<button class="result" role="listitem" data-id="${s.survivor_id}">
            <span class="result-name">${esc(s.name)}</span>
            <span class="result-sub">${esc(homeLabel(s))}</span></button>`
        )
        .join("");
    box.querySelectorAll(".result").forEach((b) =>
      b.addEventListener("click", () => selectSurvivor(b.dataset.id, true))
    );
  }

  function renderDetail(s) {
    const box = ctx.panel.querySelector(".detail");
    const conns = store.connBySurvivor.get(s.survivor_id) || [];
    box.innerHTML = `
      <article class="card">
        <h2>${esc(s.name)}</h2>
        <p class="muted small">${s.birth_year ? "b. " + s.birth_year + " · " : ""}${esc(homeLabel(s))}</p>
        ${(s.theme_tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("")}
        <p class="bio">${esc(s.bio_excerpt || "")}</p>
        <h3>Journey</h3>
        <ol class="journey">${s.waypoints.map(wpItem).join("")}</ol>
        ${connBlock(conns, s.survivor_id)}
        <p><a class="archive" href="${esc(s.archive_url)}" target="_blank" rel="noopener">
          View full archive entry ↗</a></p>
        ${s.is_sample ? '<p class="sample-flag">Illustrative sample record — not real testimony.</p>' : ""}
      </article>`;
    box.querySelectorAll("[data-place]").forEach((el) =>
      el.addEventListener("click", () => selectPlace(el.dataset.place, true))
    );
  }

  function renderPlaceDetail(place, ids) {
    const box = ctx.panel.querySelector(".detail");
    box.innerHTML = `
      <article class="card">
        <h2>${esc(place.canonical)}</h2>
        <p class="muted small">${ids.length} survivor${ids.length === 1 ? "" : "s"} connected to this place</p>
        <ul class="journey">${ids
          .map((id) => {
            const s = store.byId.get(id);
            return `<li><button class="link-btn" data-id="${id}">${esc(s.name)}</button></li>`;
          })
          .join("")}</ul>
      </article>`;
    box.querySelectorAll("[data-id]").forEach((b) =>
      b.addEventListener("click", () => selectSurvivor(b.dataset.id, true))
    );
  }

  // ---- helpers ---------------------------------------------------------------

  function wpItem(wp) {
    const p = store.places.get(wp.canonical);
    return `<li>
      <button class="wp" data-place="${p ? p.slug : ""}">
        <span class="wp-role">${ROLE_LABELS[wp.role] || wp.role}</span>
        <span class="wp-name">${esc(wp.as_written)}</span>
        <span class="wp-sub">${esc(wp.canonical)} · ${esc(dateLabel(wp.date))}</span>
      </button></li>`;
  }

  function connBlock(conns, sid) {
    if (!conns.length) return "";
    return `<h3>Shared places &amp; times</h3>
      <ul class="conns">${conns
        .map((c) => {
          const otherId = c.survivorA === sid ? c.survivorB : c.survivorA;
          const other = store.byId.get(otherId);
          return `<li>${esc(c.note)} <button class="link-btn" data-id="${otherId}">${esc(
            other ? other.name : otherId
          )}</button></li>`;
        })
        .join("")}</ul>`;
  }

  function homeLabel(s) {
    const home = s.waypoints.find((w) => w.role === "birthplace") || s.waypoints[0];
    return home ? home.as_written + " (" + home.canonical + ")" : "";
  }

  return { activate, deactivate, selectSurvivor, selectPlace };
}

// small DOM helpers
function opt(firstLabel, firstVal, values) {
  return (
    `<option value="${firstVal}">${firstLabel}</option>` +
    values.map((v) => `<option value="${escAttr(v)}">${esc(v)}</option>`).join("")
  );
}
function dateLabel(d) {
  if (!d || (!d.start && !d.end)) return "date uncertain";
  if (d.start === d.end || !d.end) return d.start || "—";
  return `${d.start}–${d.end}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}
function escAttr(s) {
  return esc(s).replace(/"/g, "&quot;");
}
