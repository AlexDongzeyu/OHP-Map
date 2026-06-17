// app.js — orchestration. Owns the small state machine, renders the persistent atlas
// (atlas.js) plus the per-view overlay (ui.js), wires interaction via delegation, runs
// the guided scroll observer, and handles hash deep links.
import { loadData } from "./data.js";
import { createAtlas } from "./atlas.js";
import * as ui from "./ui.js";
import { REDUCED_MOTION, TIME, slug } from "./config.js";

const VIEWS = ["landing", "guided", "explore", "patterns", "about"];

const state = {
  view: "landing",
  selectedId: null,
  guidedId: null,
  guidedIndex: 0,
  prevIndex: null,
  theme: null,
  scrubYear: 1942,
};

let store, atlas;
let guidedMountedFor = null;
let scrollHandler = null;

async function main() {
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const fatalEl = document.getElementById("fatal");

  try {
    store = await loadData();
  } catch (err) {
    loadingEl.hidden = true;
    fatalEl.hidden = false;
    fatalEl.textContent = "We couldn't load the journeys right now. Please refresh in a moment.";
    console.error(err);
    return;
  }

  state.guidedId = (store.featured[0] || store.journeys[0]).id;
  state.scrubYear = Math.round((store.time.min + store.time.max) / 2);
  if (store.meta && store.meta.reviewed && !store.meta.pending) {
    const pill = document.getElementById("status-pill");
    if (pill) pill.querySelector(".status-text").textContent = "Reviewed";
  }

  atlas = createAtlas(document.getElementById("map"));
  atlas.setStore(store);
  atlas.setTooltipEl(document.getElementById("tip"));

  try {
    await atlas.ready;
  } catch (err) {
    loadingEl.hidden = true;
    errorEl.hidden = false;
    console.error(err);
    return;
  }
  loadingEl.hidden = true;
  document.getElementById("topbar").hidden = false;

  // resize
  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { atlas.resize(); }, 120);
    }).observe(document.getElementById("map"));
  }

  wireGlobal();
  window.addEventListener("hashchange", route);
  route();
}

// ---- context passed to the atlas ---------------------------------------------
function atlasCtx() {
  return {
    selectedId: state.selectedId,
    guidedId: state.guidedId,
    guidedIndex: state.guidedIndex,
    prevIndex: state.prevIndex,
    theme: state.theme,
    scrubYear: state.scrubYear,
    onSelect: (id) => selectSurvivor(id),
  };
}

// ---- rendering ---------------------------------------------------------------
function render(rebuildOverlay = true) {
  const v = state.view;
  // nav active states
  document.querySelectorAll(".nav-tab").forEach((b) =>
    b.classList.toggle("on", b.dataset.view === v));
  document.body.dataset.view = v;

  atlas.render(v, atlasCtx());

  if (rebuildOverlay) mountOverlay();
}

function mountOverlay() {
  const host = document.getElementById("overlay");
  const v = state.view;
  if (v === "landing") host.innerHTML = ui.landing(store);
  else if (v === "guided") { host.innerHTML = ui.guided(store, state); guidedMountedFor = state.guidedId; setupGuidedScroll(); }
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
  if (view === "guided" && !state.guidedId) state.guidedId = (store.featured[0] || store.journeys[0]).id;
  setHash(view === "landing" ? "" : `#/${view}`);
  render();
}

function startGuided(id) {
  state.guidedId = id;
  state.guidedIndex = 0;
  state.prevIndex = null;
  state.view = "guided";
  setHash(`#/guided`);
  render(); // rebuilds narrative + resets scroll
  const narr = document.querySelector("[data-narr]");
  if (narr) narr.scrollTo({ top: 0, behavior: REDUCED_MOTION ? "auto" : "smooth" });
}

function selectSurvivor(id) {
  state.selectedId = id;
  if (state.view !== "explore") { state.view = "explore"; setHash(`#/survivor/${id}`); }
  else setHash(`#/survivor/${id}`);
  render();
}

function clearSel() {
  state.selectedId = null;
  setHash("#/explore");
  render();
}

function toggleTheme(t) {
  state.theme = t || null;
  render();
}

function setScrub(year) {
  state.scrubYear = year;
  const yEl = document.querySelector("[data-year]");
  if (yEl) yEl.textContent = year;
  atlas.render("patterns", atlasCtx()); // move dots only; don't rebuild the slider
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
      state.prevIndex = state.guidedIndex;
      state.guidedIndex = best;
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

// ---- event wiring (delegation) ----------------------------------------------
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
}

function onActivate(e) {
  const t = e.target.closest("[data-act],[data-view],[data-guided],[data-survivor],[data-theme]");
  if (!t) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.guided != null) return startGuided(t.dataset.guided);
  if (t.dataset.survivor != null) return selectSurvivor(t.dataset.survivor);
  if (t.dataset.theme != null) return toggleTheme(t.dataset.theme);
  switch (t.dataset.act) {
    case "follow": return startGuided((store.featured[0] || store.journeys[0]).id);
    case "explore": return go("explore");
    case "about": return go("about");
    case "home": return go("landing");
    case "clear": return clearSel();
  }
}

// ---- routing -----------------------------------------------------------------
let programmatic = false;
function setHash(h) {
  programmatic = true;
  if (location.hash !== h) location.hash = h;
  else programmatic = false;
}
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
