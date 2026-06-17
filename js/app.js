// app.js — orchestration. Owns the state machine, renders the persistent atlas
// (atlas.js) + the per-view overlay (ui.js), wires interaction via delegation, runs the
// guided scroll observer, handles search / group filters / density toggle, deep links.
import { loadData } from "./data.js";
import { createAtlas } from "./atlas.js";
import * as ui from "./ui.js";
import { GROUPS, REDUCED_MOTION, slug } from "./config.js";

const VIEWS = ["landing", "guided", "explore", "patterns", "about"];
const RAIL_PAGE = 140;

const state = {
  view: "landing",
  selectedId: null,
  guidedId: null,
  guidedIndex: 0,
  prevIndex: null,
  query: "",
  groupFilter: new Set(),        // populated from the data (all on by default)
  railLimit: RAIL_PAGE,
  scrubYear: 1942,
  patternsLayer: "journeys",
};

let store, atlas;
let scrollHandler = null;

async function main() {
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const fatalEl = document.getElementById("fatal");

  try { store = await loadData(); }
  catch (err) {
    loadingEl.hidden = true; fatalEl.hidden = false;
    fatalEl.textContent = "We couldn't load the journeys right now. Please refresh in a moment.";
    console.error(err); return;
  }

  state.guidedId = store.defaultGuidedId;
  state.scrubYear = Math.round((store.time.min + store.time.max) / 2);
  store.groups.forEach((g) => state.groupFilter.add(g.name));

  atlas = createAtlas(document.getElementById("map"));
  atlas.setStore(store);
  atlas.setTooltipEl(document.getElementById("tip"));

  try { await atlas.ready; }
  catch (err) { loadingEl.hidden = true; errorEl.hidden = false; console.error(err); return; }
  loadingEl.hidden = true;
  document.getElementById("topbar").hidden = false;

  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(() => { clearTimeout(t); t = setTimeout(() => atlas.resize(), 120); })
      .observe(document.getElementById("map"));
  }

  wireGlobal();
  window.addEventListener("hashchange", route);
  route();
}

function matchPredicate() {
  const q = (state.query || "").trim().toLowerCase();
  return (j) => state.groupFilter.has(j.group) &&
    (!q || hay(j).includes(q));
}
function hay(j) {
  return (j.name + " " + j.hometown + " " + j.group + " " + j.conflicts.join(" ") + " " +
    j.themes.join(" ") + " " + j.waypoints.map((w) => w.canonical).join(" ")).toLowerCase();
}

function atlasCtx() {
  return {
    selectedId: state.selectedId,
    guidedId: state.guidedId,
    guidedIndex: state.guidedIndex,
    prevIndex: state.prevIndex,
    scrubYear: state.scrubYear,
    patternsLayer: state.patternsLayer,
    matches: matchPredicate(),
    onSelect: (id) => selectSurvivor(id),
  };
}

function render() {
  const v = state.view;
  document.querySelectorAll(".nav-tab").forEach((b) => b.classList.toggle("on", b.dataset.view === v));
  document.body.dataset.view = v;
  atlas.render(v, atlasCtx());
  mountOverlay();
}

function mountOverlay() {
  const host = document.getElementById("overlay");
  const v = state.view;
  if (v === "landing") host.innerHTML = ui.landing(store);
  else if (v === "guided") { host.innerHTML = ui.guided(store, state); setupGuidedScroll(); }
  else if (v === "explore") { host.innerHTML = ui.explore(store, state); afterExplore(); }
  else if (v === "patterns") host.innerHTML = ui.patterns(store, state);
  else if (v === "about") host.innerHTML = ui.about(store);
  wireOverlay();
}

function afterExplore() {
  if (state.selectedId) {
    const miniEl = document.querySelector("[data-mini]");
    if (miniEl) atlas.drawMini(miniEl, store.byId.get(state.selectedId));
  }
}

// ---- actions -----------------------------------------------------------------
function go(view) {
  if (!VIEWS.includes(view)) view = "landing";
  state.view = view;
  if (view === "guided" && !state.guidedId) state.guidedId = store.defaultGuidedId;
  setHash(view === "landing" ? "" : `#/${view}`);
  render();
}
function startGuided(id) {
  state.guidedId = id; state.guidedIndex = 0; state.prevIndex = null; state.view = "guided";
  setHash("#/guided"); render();
  const narr = document.querySelector("[data-narr]");
  if (narr) narr.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });
}
function selectSurvivor(id) {
  state.selectedId = id; state.view = "explore"; setHash(`#/survivor/${id}`); render();
}
function clearSel() { state.selectedId = null; setHash("#/explore"); render(); }

function toggleGroup(name) {
  if (state.groupFilter.has(name)) {
    if (state.groupFilter.size === store.groups.length) {
      // first click on a chip when all are on → solo that group
      state.groupFilter = new Set([name]);
    } else state.groupFilter.delete(name);
  } else state.groupFilter.add(name);
  if (!state.groupFilter.size) store.groups.forEach((g) => state.groupFilter.add(g.name));
  state.railLimit = RAIL_PAGE;
  render();
}

function onSearch(value) {
  state.query = value; state.railLimit = RAIL_PAGE;
  refreshRail();
  atlas.render("explore", atlasCtx());
}
function showMore() { state.railLimit += RAIL_PAGE * 2; refreshRail(); }
function refreshRail() {
  const { html, shown, total } = ui.railInner(store, state);
  const list = document.querySelector("[data-rail-list]");
  const cnt = document.querySelector("[data-rail-count]");
  if (list) list.innerHTML = html;
  if (cnt) cnt.textContent = `${shown} of ${total} shown`;
}

function setLayer(layer) { if (state.patternsLayer !== layer) { state.patternsLayer = layer; render(); } }
function setScrub(year) {
  state.scrubYear = year;
  const yEl = document.querySelector("[data-year]"); if (yEl) yEl.textContent = year;
  atlas.render("patterns", atlasCtx());
}

// ---- guided scroll observer --------------------------------------------------
function setupGuidedScroll() {
  teardownGuidedScroll();
  const root = document.querySelector("[data-narr]");
  if (!root) return;
  scrollHandler = () => {
    const secs = root.querySelectorAll("[data-chapter]");
    if (!secs.length) return;
    const rr = root.getBoundingClientRect();
    const mid = rr.top + rr.height * 0.5;
    let best = 0, bestD = Infinity;
    secs.forEach((s) => {
      const r = s.getBoundingClientRect();
      const d = Math.abs(r.top + r.height * 0.5 - mid);
      if (d < bestD) { bestD = d; best = parseInt(s.dataset.chapter, 10) || 0; }
    });
    if (best !== state.guidedIndex) {
      state.prevIndex = state.guidedIndex; state.guidedIndex = best;
      atlas.render("guided", atlasCtx());
      secs.forEach((s) => s.classList.toggle("is-active", parseInt(s.dataset.chapter, 10) === best));
    }
  };
  root.addEventListener("scroll", scrollHandler, { passive: true });
  scrollHandler();
}
function teardownGuidedScroll() {
  const root = document.querySelector("[data-narr]");
  if (scrollHandler && root) root.removeEventListener("scroll", scrollHandler);
  scrollHandler = null;
}

// ---- event wiring ------------------------------------------------------------
function wireGlobal() {
  document.getElementById("topbar").addEventListener("click", onActivate);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (state.view === "about") go("explore");
      else if (state.selectedId) clearSel();
    }
  });
}
function wireOverlay() {
  const host = document.getElementById("overlay");
  host.onclick = onActivate;
  const range = host.querySelector("[data-scrub]");
  if (range) range.addEventListener("input", () => setScrub(parseInt(range.value, 10)));
  const search = host.querySelector("#search");
  if (search) {
    search.addEventListener("input", () => onSearch(search.value));
    if (state.query) { search.focus(); search.setSelectionRange(state.query.length, state.query.length); }
  }
}
function onActivate(e) {
  const t = e.target.closest("[data-act],[data-view],[data-guided],[data-survivor],[data-group],[data-layer]");
  if (!t) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.layer) return setLayer(t.dataset.layer);
  if (t.dataset.guided != null) return startGuided(t.dataset.guided);
  if (t.dataset.survivor != null) return selectSurvivor(t.dataset.survivor);
  if (t.dataset.group != null) return toggleGroup(t.dataset.group);
  switch (t.dataset.act) {
    case "follow": return startGuided(store.defaultGuidedId);
    case "explore": return go("explore");
    case "about": return go("about");
    case "home": return go("landing");
    case "clear": return clearSel();
    case "more": return showMore();
  }
}

// ---- routing -----------------------------------------------------------------
let programmatic = false;
function setHash(h) { programmatic = true; if (location.hash !== h) location.hash = h; else programmatic = false; }
function route() {
  if (programmatic) { programmatic = false; return; }
  const hash = location.hash || "";
  const [, kind, value] = hash.split("/");
  if (kind === "survivor" && value && store.byId.has(value)) {
    state.selectedId = value; state.view = "explore"; render(); return;
  }
  if (kind === "place" && value) {
    const found = store.journeys.find((j) => j.waypoints.some((w) => slug(w.canonical) === value));
    state.view = "explore"; state.selectedId = found ? found.id : null; render(); return;
  }
  if (VIEWS.includes(kind)) { state.view = kind; render(); return; }
  state.view = "landing"; render();
}

main();
