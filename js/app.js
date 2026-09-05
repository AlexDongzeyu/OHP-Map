// app.js — orchestration. Owns the state machine, renders the persistent atlas
// (atlas.js) + the per-view overlay (ui.js), and wires collection, media and history controls.
import { loadData } from "./data.js";
import { createAtlas } from "./atlas.js";
import * as ui from "./ui.js";
import * as motion from "./motion.js";
import { motionEnabled, slug } from "./config.js";
import { playerURL } from "./media.js";

const VIEWS = ["landing", "explore", "patterns", "about"];
const RAIL_PAGE = 140;

const state = {
  view: "landing",
  selectedId: null,
  activePlaceIndex: null,
  query: "",
  groupFilter: new Set(),        // populated from the data (all on by default)
  railLimit: RAIL_PAGE,
  scrubYear: 1944,
  patternsLayer: "journeys",
  patternEventKey: null,
  historyCountry: null,
  historyInfo: null,
  historyFlags: true,
  historyLabels: true,
  historyRoutes: true,
  historyTestimony: true,
  historyCompare: false,
  historyOpacity: 1,
  historySplit: 50,
  historyPlaying: false,
  historyContextOpen: null,
  pendingHistoryCamera: null,
};

let store, atlas;
let historyTimer = null;
let rendered = { view: null, selectedId: null, patternsLayer: null };

async function main() {
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const fatalEl = document.getElementById("fatal");

  try { store = await loadData(); }
  catch (err) {
    loadingEl.hidden = true; fatalEl.hidden = false;
    console.error(err); return;
  }

  state.patternEventKey = null;
  store.groups.forEach((g) => state.groupFilter.add(g.name));
  document.getElementById("portrait-field").innerHTML = ui.livingMosaic(store);

  atlas = createAtlas(document.getElementById("map"));
  atlas.setStore(store);
  atlas.setTooltipEl(document.getElementById("tip"));
  atlas.onUserCameraChange = () => { state.pendingHistoryCamera = null; };
  atlas.onHistoryReady = () => {
    if (state.view !== "patterns") return;
    populateHistoryLocations();
    updateHistoryInfo();
    refreshPatternEvents();
    atlas.render("patterns", atlasCtx());
    restoreHistoryCamera();
  };

  try { await atlas.ready; }
  catch (err) { loadingEl.hidden = true; errorEl.hidden = false; console.error(err); return; }
  document.getElementById("topbar").hidden = false;
  motion.init();

  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(() => {
      clearTimeout(t);
      t = setTimeout(() => { atlas.resize(); restoreHistoryCamera(); }, 120);
    })
      .observe(document.getElementById("map"));
  }

  wireGlobal();
  window.addEventListener("hashchange", route);
  route();
  motion.animateShell();
  dismissLoading(loadingEl);
}

function dismissLoading(element) {
  element.classList.add("is-leaving");
  const finish = () => { element.hidden = true; };
  element.addEventListener("transitionend", finish, { once: true });
  window.setTimeout(finish, 700);
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
  const patternEvents = eventsForYear();
  const selected = store.byId.get(state.selectedId);
  let warPeriod = null;
  let boundaryYear = null;
  if (state.view === "patterns" && state.patternsLayer === "journeys") {
    warPeriod = store.warAt(state.scrubYear);
    boundaryYear = state.scrubYear;
  } else if (state.view === "explore" && selected) {
    const year = selected.waypoints[state.activePlaceIndex]?.historyYear;
    warPeriod = year ? store.warAt(year) : null;
    boundaryYear = year >= store.time.min && year <= store.time.max
      ? year : null;
  }
  return {
    selectedId: state.selectedId,
    activePlaceIndex: state.activePlaceIndex,
    scrubYear: state.scrubYear,
    patternsLayer: state.patternsLayer,
    patternEvents,
    activePatternEvent: patternEvents.find((event) => event.key === state.patternEventKey) || null,
    warPeriod,
    boundaryYear,
    matches: matchPredicate(),
    onSelect: (id) => selectSurvivor(id),
    onEvent: (key) => setPatternEvent(key),
    onController: (name) => selectCountry(name),
    historyCountry: state.historyCountry,
    historyFlags: state.historyFlags,
    historyLabels: state.historyLabels,
    historyRoutes: state.historyRoutes,
    historyTestimony: state.historyTestimony,
    historyCompare: state.historyCompare,
    historyOpacity: state.historyOpacity,
    historySplit: state.historySplit,
    datedCorridors: store.corridorsForYear(state.scrubYear),
  };
}

function render(preserveBrowse = false) {
  const v = state.view;
  const changes = {
    viewChanged: rendered.view !== v,
    selectionChanged: rendered.selectedId !== state.selectedId,
    layerChanged: rendered.patternsLayer !== state.patternsLayer,
  };
  const list = preserveBrowse ? document.querySelector("[data-rail-list]") : null;
  const browseScroll = list?.scrollTop || 0;
  const filtersOpen = preserveBrowse && document.querySelector(".collection-filters")?.open;
  document.querySelectorAll("#topbar [data-view]").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document.body.dataset.view = v;
  mountOverlay();
  if (list) {
    document.querySelector(".collection-filters").open = filtersOpen;
    document.querySelector("[data-rail-list]").scrollTop = browseScroll;
  }
  atlas.render(v, atlasCtx());
  restoreHistoryCamera();
  motion.animateOverlay(v, changes);
  rendered = {
    view: v,
    selectedId: state.selectedId,
    patternsLayer: state.patternsLayer,
  };
}

function mountOverlay() {
  const host = document.getElementById("overlay");
  const v = state.view;
  if (v === "landing") host.innerHTML = ui.landing(store);
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
  if (view === state.view) return;
  stopHistoryPlayback();
  state.view = view;
  const hash = view === "landing" ? "" : (
    view === "patterns" ? historyHash() : `#/${view}`
  );
  setHash(hash);
  render();
}
function selectSurvivor(id) {
  stopHistoryPlayback();
  state.selectedId = id; state.activePlaceIndex = null;
  state.view = "explore"; setHash(`#/survivor/${id}`); render(true);
  document.getElementById("profile-name")?.focus({ preventScroll: true });
}
function clearSel() {
  const id = state.selectedId;
  state.selectedId = null; state.activePlaceIndex = null;
  setHash("#/explore"); render(true);
  const source = id && document.querySelector(`[data-survivor="${CSS.escape(id)}"]`);
  (source || document.getElementById("search"))?.focus({ preventScroll: true });
}

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
  document.querySelector(`[data-group="${CSS.escape(name)}"]`)?.focus({ preventScroll: true });
}

function resetSearch() {
  state.query = "";
  state.groupFilter = new Set(store.groups.map((group) => group.name));
  state.railLimit = RAIL_PAGE;
  render();
  document.getElementById("search").focus();
}

function focusPlace(index) {
  const journey = store.byId.get(state.selectedId);
  if (!Number.isInteger(index) || !journey?.waypoints[index]) {
    console.warn("The selected place is not in this account.");
    return;
  }
  state.activePlaceIndex = index;
  document.querySelectorAll("[data-place-step]").forEach((button) => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.placeStep) === index));
  });
  atlas.render("explore", atlasCtx());
}

function showInterviews() {
  const section = document.getElementById("profile-interviews");
  if (!section) {
    console.warn("This account has no interview inventory.");
    return;
  }
  document.querySelector(".panel").scrollTo({
    top: section.offsetTop - 16,
    behavior: motionEnabled() ? "smooth" : "auto",
  });
  document.getElementById("interviews-title").focus({ preventScroll: true });
}

function playVideo(id) {
  const journey = store.byId.get(state.selectedId);
  const video = journey?.media.videos.find((entry) => entry.id === id);
  const url = video && playerURL(video);
  if (!url) {
    console.warn("This interview chapter is not available for embedded playback.");
    return;
  }
  const player = document.querySelector("[data-player]");
  const frame = document.createElement("iframe");
  frame.src = url;
  frame.title = `${journey.name}: ${video.title}`;
  frame.allow = "autoplay; fullscreen; picture-in-picture; encrypted-media";
  frame.allowFullscreen = true;
  frame.referrerPolicy = "strict-origin-when-cross-origin";
  frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-presentation allow-popups");
  player.querySelector("[data-player-frame]").replaceChildren(frame);
  const title = player.querySelector("[data-player-title]");
  title.textContent = video.title;
  title.tabIndex = -1;
  player.hidden = false;
  player.dataset.playing = id;
  document.querySelectorAll("[data-video]").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.video === id));
  });
  document.querySelector(".panel").scrollTo({
    top: player.offsetTop - 16,
    behavior: motionEnabled() ? "smooth" : "auto",
  });
  title.focus({ preventScroll: true });
}

function closeVideo() {
  const player = document.querySelector("[data-player]");
  const id = player.dataset.playing;
  player.querySelector("[data-player-frame]").replaceChildren();
  player.hidden = true;
  document.querySelectorAll("[data-video]").forEach((button) => button.setAttribute("aria-pressed", "false"));
  document.querySelector(`[data-video="${CSS.escape(id || "")}"]`)?.focus({ preventScroll: true });
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

function setLayer(layer) {
  if (state.patternsLayer !== layer) {
    stopHistoryPlayback();
    state.patternsLayer = layer;
    state.patternEventKey = null;
    syncHistoryAddress();
    render();
    if (layer === "origins") atlas.resetCamera();
  }
}
function setScrub(year) {
  if (!Number.isFinite(year)) {
    console.warn("The historical year must be a number.");
    return;
  }
  const camera = atlas.cameraPosition();
  state.scrubYear = Math.max(store.time.min, Math.min(store.time.max, year));
  state.patternEventKey = null;
  updateHistoryInfo();
  syncHistoryAddress();
  refreshPatternEvents();
  populateHistoryLocations();
  atlas.render("patterns", atlasCtx());
  if (camera) atlas.focusCoordinates(camera.lng, camera.lat, camera.zoom, false);
}

function setPatternEvent(key) {
  const event = store.events.find((candidate) => candidate.key === key);
  if (!event) return;
  state.scrubYear = event.year;
  state.patternEventKey = event.key;
  stopHistoryPlayback();
  syncHistoryAddress();
  refreshPatternEvents();
  atlas.render("patterns", atlasCtx());
}

function stepEventYear(direction) {
  setScrub(state.scrubYear + direction);
}

function stepPatternEvent(direction) {
  const events = eventsForYear();
  if (!events.length) return;
  let index = events.findIndex((event) => event.key === state.patternEventKey);
  if (index < 0) index = direction > 0 ? -1 : 0;
  index = (index + direction + events.length) % events.length;
  setPatternEvent(events[index].key);
}

function eventsForYear() {
  return store?.eventsByYear.get(state.scrubYear) || [];
}

function refreshPatternEvents() {
  const host = document.querySelector("[data-pattern-events]");
  if (host) {
    host.innerHTML = ui.patternsEvents(store, state);
    host.querySelectorAll("img").forEach((image) => {
      image.addEventListener("error", () => image.remove(), { once: true });
    });
  }
  document.querySelectorAll("[data-year]").forEach((year) => {
    if (year instanceof HTMLInputElement) year.value = state.scrubYear;
    else year.textContent = state.scrubYear;
  });
  const range = document.querySelector("[data-scrub]");
  if (range) range.value = state.scrubYear;
  document.querySelectorAll("[data-boundary-year]").forEach((marker) => {
    marker.classList.toggle("on", Number(marker.dataset.boundaryYear) === state.scrubYear);
  });
  const previous = document.querySelector("[data-act='prev-year']");
  const next = document.querySelector("[data-act='next-year']");
  if (previous) previous.disabled = state.scrubYear <= store.time.min;
  if (next) next.disabled = state.scrubYear >= store.time.max;
  const routeNotice = document.querySelector("[data-route-availability]");
  if (routeNotice) routeNotice.textContent = store.corridorsForYear(state.scrubYear).length
    ? "Only person-linked city/site pairs dated to this year are connected."
    : "No shared city/site routes have sufficient date evidence for this year.";
  motion.animatePatternEvent();
}

function updateHistoryInfo() {
  state.historyInfo = state.historyCountry ? atlas.countryInfo(state.historyCountry, state.scrubYear) : null;
  if (state.historyInfo) state.historyCountry = state.historyInfo.controller;
  if (state.historyCountry && !state.historyInfo && atlas.historyLoaded()) {
    state.historyCountry = null;
  }
}

function selectCountry(name) {
  stopHistoryPlayback();
  state.pendingHistoryCamera = null;
  const info = name ? atlas.countryInfo(name, state.scrubYear) : null;
  if (name && !info) {
    const status = document.querySelector("[data-search-status]");
    if (status) status.textContent = `That administration is not mapped in ${state.scrubYear}. Try another year.`;
    return;
  }
  state.historyCountry = info?.controller || null;
  state.historyInfo = info;
  const searchStatus = document.querySelector("[data-search-status]");
  if (searchStatus) searchStatus.textContent = info ? `Showing ${info.name} in ${state.scrubYear}.` : "";
  state.historyContextOpen = true;
  const disclosure = document.querySelector("[data-history-context]");
  if (disclosure) disclosure.open = true;
  state.patternEventKey = null;
  syncHistoryAddress();
  refreshPatternEvents();
  atlas.render("patterns", atlasCtx());
  if (!name) atlas.resetCamera();
  (document.querySelector(".country-heading h3") || document.querySelector("[data-country-search]"))?.focus({ preventScroll: true });
}

function populateHistoryLocations() {
  const list = document.getElementById("history-locations");
  if (!list) return;
  const options = atlas.searchLocations("", state.scrubYear).map((location) => {
    const option = document.createElement("option");
    option.value = location.name;
    option.label = location.kind === "country" ? "Historical territory" : "Place in an OHP account";
    return option;
  });
  list.replaceChildren(...options);
}

function findHistoryLocation() {
  const input = document.querySelector("[data-country-search]");
  const status = document.querySelector("[data-search-status]");
  const query = input.value.trim();
  if (!query) {
    status.textContent = "Enter a country or a place named in an OHP account.";
    input.focus();
    return;
  }
  const matches = atlas.searchLocations(query, state.scrubYear);
  if (!matches.length) {
    status.textContent = atlas.historyLoaded()
      ? `No mapped country or OHP place matched "${query}" in ${state.scrubYear}. Try another name or year.`
      : "The dated territory records have not loaded. Try an OHP place or reload the page.";
    atlas.resize();
    return;
  }
  const match = matches[0];
  status.textContent = match.kind === "country"
    ? `Showing ${match.name} in ${state.scrubYear}.`
    : `Centred on ${match.name}. The borders still show ${state.scrubYear}.`;
  if (match.kind === "country") selectCountry(match.name);
  else {
    state.historyCountry = null;
    state.historyInfo = null;
    refreshPatternEvents();
    atlas.render("patterns", atlasCtx());
    atlas.focusCoordinates(match.lng, match.lat, 4);
  }
  syncHistoryAddress();
}

function historyHash(includeCamera = false) {
  const params = new URLSearchParams();
  if (state.patternsLayer === "origins") params.set("layer", "origins");
  if (state.historyCountry) params.set("country", state.historyCountry);
  for (const [key, field] of Object.entries({
    flags: "historyFlags", labels: "historyLabels", routes: "historyRoutes", testimony: "historyTestimony",
  })) if (!state[field]) params.set(key, "0");
  if (state.historyCompare) params.set("compare", "1");
  if (state.historyOpacity !== 1) params.set("opacity", state.historyOpacity);
  if (state.historySplit !== 50) params.set("split", state.historySplit);
  const camera = includeCamera ? atlas.cameraPosition() : null;
  if (camera) {
    params.set("lng", camera.lng.toFixed(4));
    params.set("lat", camera.lat.toFixed(4));
    params.set("zoom", camera.zoom.toFixed(3));
  }
  const query = params.toString();
  return `#/patterns/${state.scrubYear}${query ? `?${query}` : ""}`;
}

function restoreHistoryCamera() {
  const camera = state.pendingHistoryCamera;
  if (!camera || state.view !== "patterns") return;
  atlas.focusCoordinates(camera.lng, camera.lat, camera.zoom, false);
  if (atlas.historyLoaded() || state.patternsLayer === "origins") state.pendingHistoryCamera = null;
}

function syncHistoryAddress() {
  if (state.view === "patterns") history.replaceState(null, "", historyHash());
}

function updateHistoryDisplay() {
  const compare = document.querySelector("[data-compare-control]");
  const caption = document.querySelector("[data-compare-caption]");
  const frameChanged = caption && caption.hidden === state.historyCompare;
  if (compare) compare.hidden = !state.historyCompare;
  if (caption) caption.hidden = !state.historyCompare;
  atlas.setHistoryDisplay({
    compare: state.historyCompare, split: state.historySplit, opacity: state.historyOpacity,
  });
  if (frameChanged) atlas.resize();
  syncHistoryAddress();
}

function stopHistoryPlayback() {
  if (historyTimer) window.clearInterval(historyTimer);
  historyTimer = null;
  state.historyPlaying = false;
  updatePlaybackButton();
}

function updatePlaybackButton() {
  const button = document.querySelector("[data-act='play-history']");
  if (!button) return;
  button.setAttribute("aria-pressed", String(state.historyPlaying));
  button.setAttribute("aria-label", state.historyPlaying ? "Pause history" : "Play history");
  button.querySelector("use").setAttribute("href", state.historyPlaying ? "#icon-pause" : "#icon-play");
}

function toggleHistoryPlayback() {
  if (state.historyPlaying) { stopHistoryPlayback(); return; }
  if (state.scrubYear === store.time.max) setScrub(store.time.min);
  state.historyPlaying = true;
  updatePlaybackButton();
  historyTimer = window.setInterval(() => {
    if (state.view !== "patterns" || document.hidden || state.scrubYear >= store.time.max) {
      stopHistoryPlayback();
      return;
    }
    setScrub(state.scrubYear + 1);
  }, 1200);
}

async function shareMap() {
  const address = `${location.origin}${location.pathname}${historyHash(true)}`;
  const status = document.querySelector("[data-share-status]");
  const fallback = document.querySelector("[data-share-address]");
  fallback.value = address;
  if (!navigator.clipboard) {
    fallback.hidden = false;
    fallback.select();
    status.textContent = "Copy this link to share the selected year and map layers.";
    return;
  }
  try {
    await navigator.clipboard.writeText(address);
    status.textContent = "The map link has been copied.";
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    fallback.hidden = false;
    fallback.select();
    status.textContent = "Clipboard access was blocked. You can copy this link.";
  }
}

// ---- event wiring ------------------------------------------------------------
function wireGlobal() {
  document.getElementById("topbar").addEventListener("click", onActivate);
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopHistoryPlayback(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const settings = document.querySelector(".history-settings[open]");
      if (settings) {
        settings.open = false;
        settings.querySelector("summary").focus();
      } else if (state.historyPlaying) stopHistoryPlayback();
      else if (state.view === "patterns" && state.historyCountry) selectCountry(null);
      else if (state.view === "about") go("explore");
      else if (state.view === "explore" && state.selectedId) clearSel();
    }
  });
}
function wireOverlay() {
  const host = document.getElementById("overlay");
  host.onclick = onActivate;
  host.querySelectorAll(".medal img").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
  host.querySelectorAll(".profile-photo img").forEach((image) => {
    image.addEventListener("error", () => {
      image.parentElement.textContent = "This photograph could not load. Open the source image.";
      console.warn("An OHP gallery photograph could not load.");
    }, { once: true });
  });
  const range = host.querySelector("[data-scrub]");
  if (range) range.addEventListener("input", () => setScrub(parseInt(range.value, 10)));
  const yearForm = host.querySelector("[data-year-form]");
  if (yearForm) {
    const year = yearForm.querySelector("input");
    const submitYear = () => {
      if (year.reportValidity()) setScrub(Number(year.value));
    };
    yearForm.addEventListener("submit", (event) => { event.preventDefault(); submitYear(); });
    year.addEventListener("change", submitYear);
  }
  const historySearch = host.querySelector("[data-history-search]");
  if (historySearch) {
    historySearch.addEventListener("submit", (event) => { event.preventDefault(); findHistoryLocation(); });
    populateHistoryLocations();
  }
  host.querySelector("[data-history-context]")?.addEventListener("toggle", (event) => {
    state.historyContextOpen = event.target.open;
    atlas.resize();
  });
  for (const input of host.querySelectorAll("[data-history-setting]")) {
    input.addEventListener("change", () => {
      const keys = { flags: "historyFlags", labels: "historyLabels", routes: "historyRoutes", testimony: "historyTestimony", compare: "historyCompare" };
      state[keys[input.dataset.historySetting]] = input.checked;
      if (input.dataset.historySetting === "testimony" && !input.checked) state.patternEventKey = null;
      refreshPatternEvents();
      atlas.render("patterns", atlasCtx());
      updateHistoryDisplay();
    });
  }
  host.querySelector("[data-history-opacity]")?.addEventListener("input", (event) => {
    state.historyOpacity = Number(event.target.value);
    updateHistoryDisplay();
  });
  host.querySelector("[data-history-split]")?.addEventListener("input", (event) => {
    state.historySplit = Number(event.target.value);
    updateHistoryDisplay();
  });
  const search = host.querySelector("#search");
  if (search) {
    search.addEventListener("input", () => onSearch(search.value));
  }
}
function onActivate(e) {
  const t = e.target.closest("[data-act],[data-view],[data-survivor],[data-group],[data-layer],[data-event],[data-place-step],[data-video]");
  if (!t) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.layer) return setLayer(t.dataset.layer);
  if (t.dataset.survivor != null) return selectSurvivor(t.dataset.survivor);
  if (t.dataset.group != null) return toggleGroup(t.dataset.group);
  if (t.dataset.event != null) return setPatternEvent(t.dataset.event);
  if (t.dataset.placeStep != null) return focusPlace(Number(t.dataset.placeStep));
  if (t.dataset.video != null) return playVideo(t.dataset.video);
  switch (t.dataset.act) {
    case "explore": return go("explore");
    case "about": return go("about");
    case "home": return go("landing");
    case "clear": return clearSel();
    case "more": return showMore();
    case "reset-search": return resetSearch();
    case "show-interviews": return showInterviews();
    case "close-video": return closeVideo();
    case "zoom-in": state.pendingHistoryCamera = null; return atlas.zoomBy(1.5);
    case "zoom-out": state.pendingHistoryCamera = null; return atlas.zoomBy(1 / 1.5);
    case "reset-map":
      state.activePlaceIndex = null;
      state.pendingHistoryCamera = null;
      document.querySelectorAll("[data-place-step]").forEach((button) => button.setAttribute("aria-pressed", "false"));
      atlas.render(state.view, atlasCtx());
      return atlas.resetCamera();
    case "prev-year": return stepEventYear(-1);
    case "next-year": return stepEventYear(1);
    case "prev-event": return stepPatternEvent(-1);
    case "next-event": return stepPatternEvent(1);
    case "clear-country": return selectCountry(null);
    case "play-history": return toggleHistoryPlayback();
    case "share-map": return shareMap();
  }
}

// ---- routing -----------------------------------------------------------------
let programmatic = false;
function setHash(h) { programmatic = true; if (location.hash !== h) location.hash = h; else programmatic = false; }
function route() {
  if (programmatic) { programmatic = false; return; }
  stopHistoryPlayback();
  const [hash, query = ""] = (location.hash || "").split("?");
  const params = new URLSearchParams(query);
  const [, kind, value] = hash.split("/");
  if (kind === "guided") {
    history.replaceState(null, "", "#/explore");
    state.view = "explore";
    state.selectedId = null;
    state.activePlaceIndex = null;
    render();
    return;
  }
  if (kind === "survivor" && value && store.byId.has(value)) {
    state.selectedId = store.byId.get(value).id;
    state.activePlaceIndex = null;
    state.view = "explore";
    if (state.selectedId !== value) history.replaceState(null, "", `#/survivor/${state.selectedId}`);
    render();
    return;
  }
  if (kind === "place" && value) {
    const found = store.journeys.find((j) => j.waypoints.some((w) => slug(w.canonical) === value));
    state.view = "explore"; state.selectedId = found ? found.id : null; render(); return;
  }
  if (kind === "patterns" && value && /^\d{4}$/.test(value)) {
    state.scrubYear = Math.max(store.time.min, Math.min(store.time.max, Number(value)));
    state.patternEventKey = null;
    state.patternsLayer = params.get("layer") === "origins" ? "origins" : "journeys";
    state.historyCountry = params.get("country") || null;
    state.historyFlags = params.get("flags") !== "0";
    state.historyLabels = params.get("labels") !== "0";
    state.historyRoutes = params.get("routes") !== "0";
    state.historyTestimony = params.get("testimony") !== "0";
    state.historyCompare = params.get("compare") === "1";
    const opacity = Number(params.get("opacity") || 1), split = Number(params.get("split") ?? 50);
    state.historyOpacity = Number.isFinite(opacity) ? Math.max(.2, Math.min(1, opacity)) : 1;
    state.historySplit = Number.isFinite(split) ? Math.max(0, Math.min(100, split)) : 50;
    const lng = Number(params.get("lng")), lat = Number(params.get("lat")), zoom = Number(params.get("zoom"));
    state.pendingHistoryCamera = params.has("lng") && params.has("lat") && params.has("zoom") &&
      [lng, lat, zoom].every(Number.isFinite) && Math.abs(lng) <= 180 && Math.abs(lat) <= 90 && zoom >= 1 && zoom <= 14
      ? { lng, lat, zoom } : null;
    updateHistoryInfo();
    state.view = "patterns";
    render();
    return;
  }
  if (VIEWS.includes(kind)) { state.view = kind; render(); return; }
  state.view = "landing"; render();
}

main();
