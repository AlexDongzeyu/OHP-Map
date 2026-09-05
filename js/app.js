// app.js — orchestration. Owns the state machine, renders the persistent atlas
// (atlas.js) + the per-view overlay (ui.js), and wires collection, media and history controls.
import { loadData, journeyFilter } from "./data.js";
import { createAtlas } from "./atlas.js";
import * as ui from "./ui.js";
import * as motion from "./motion.js";
import { motionEnabled, slug } from "./config.js";
import { playerURL } from "./media.js";

const VIEWS = ["landing", "explore", "patterns", "about", "not-found"];
const RAIL_PAGE = 140;
const MOBILE = window.matchMedia("(max-width: 820px)");
const SHORT_VIEWPORT = window.matchMedia("(max-width: 820px) and (max-height: 540px)");

const state = {
  view: "landing",
  selectedId: null,
  activePlaceIndex: null,
  explorePresentation: "auto",
  missingKind: null,
  query: "",
  groupFilter: new Set(),        // populated from the data (all on by default)
  originCountry: null,
  railLimit: RAIL_PAGE,
  scrubYear: 1944,
  patternsLayer: "journeys",
  patternEventKey: null,
  historyCountry: null,
  historyInfo: null,
  historyQuery: "",
  historySearchMessage: "",
  historyMatches: [],
  historyPlace: null,
  historyFlags: true,
  historyLabels: true,
  historyRoutes: true,
  historyTestimony: true,
  historyCompare: false,
  historyOpacity: 1,
  historySplit: 50,
  historyPlaying: false,
  historyContextOpen: null,
  historyPlacesOpen: false,
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
  atlas.onHistoryStatus = updateBoundaryNotice;
  atlas.onHistoryReady = () => {
    updateBoundaryNotice();
    if (state.view !== "patterns") return;
    populateHistoryLocations();
    updateHistoryInfo();
    refreshPatternEvents(true);
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
      t = setTimeout(() => { syncPresentation(); atlas.resize(); restoreHistoryCamera(); }, 120);
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
  return journeyFilter(state);
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
    onPlace: (index) => inspectAccountPlace(index),
    onEvent: (key) => setPatternEvent(key),
    onController: (name) => selectCountry(name),
    onOrigin: (name) => openOrigin(name),
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
  const railScroll = preserveBrowse ? document.querySelector(".rail")?.scrollTop || 0 : 0;
  const filtersOpen = preserveBrowse && document.querySelector(".collection-filters")?.open;
  document.querySelectorAll("#topbar [data-view]").forEach((b) => {
    const on = b.dataset.view === v;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  document.body.dataset.view = v;
  mountOverlay();
  syncPresentation();
  if (list) {
    document.querySelector(".collection-filters").open = filtersOpen;
    document.querySelector("[data-rail-list]").scrollTop = browseScroll;
    document.querySelector(".rail").scrollTop = railScroll;
  }
  atlas.render(v, atlasCtx());
  updateBoundaryNotice();
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
  else if (v === "not-found") host.innerHTML = ui.notFound(state.missingKind);
  wireOverlay();
}

function afterExplore() {
  if (state.selectedId) {
    const miniEl = document.querySelector("[data-mini]");
    if (miniEl) atlas.drawMini(miniEl, store.byId.get(state.selectedId));
  }
}

function explorePresentation() {
  if (!MOBILE.matches) return "split";
  return state.explorePresentation === "auto"
    ? (SHORT_VIEWPORT.matches ? "reader" : "split") : state.explorePresentation;
}

function syncPresentation() {
  const presentation = explorePresentation();
  const overlay = document.querySelector(".ov-explore");
  if (overlay) {
    overlay.dataset.presentation = presentation;
    const toggle = overlay.querySelector(".reader-toggle");
    if (toggle) {
      toggle.querySelector("[data-reader-label]").textContent = presentation === "reader" ? "Map" : "Expand";
      toggle.setAttribute("aria-label", presentation === "reader" ? "Show the account map" : "Expand account reader");
      toggle.querySelector("use").setAttribute("href", presentation === "reader" ? "#icon-arrow-right" : "#icon-fit");
    }
  }
  const historyReading = state.view === "patterns" && SHORT_VIEWPORT.matches &&
    document.querySelector("[data-history-context]")?.open;
  const hideMap = ["about", "not-found"].includes(state.view) ||
    (state.view === "explore" && presentation === "reader") || historyReading;
  const map = document.getElementById("map");
  map.inert = Boolean(hideMap);
  map.style.visibility = hideMap ? "hidden" : "";
  map.setAttribute("aria-hidden", String(Boolean(hideMap)));
}

function setExplorePresentation(presentation) {
  state.explorePresentation = presentation;
  syncPresentation();
  atlas.resize();
  const focus = presentation === "map" ? document.querySelector(".reader-return")
    : state.selectedId ? document.querySelector(".reader-toggle") : document.getElementById("search");
  focus?.focus({ preventScroll: true });
}

function toggleReader() {
  setExplorePresentation(explorePresentation() === "reader"
    ? (SHORT_VIEWPORT.matches ? "map" : "auto") : "reader");
}

// ---- actions -----------------------------------------------------------------
function go(view) {
  if (!VIEWS.includes(view)) view = "landing";
  if (view === "explore" && state.view === "explore" && state.selectedId) return clearSel();
  if (view === state.view) return;
  stopHistoryPlayback();
  if (view === "explore") {
    state.selectedId = null;
    state.activePlaceIndex = null;
    state.explorePresentation = "auto";
  }
  state.view = view;
  const hash = view === "landing" ? "" : (
    view === "patterns" ? historyHash() : (view === "explore" ? exploreHash() : `#/${view}`)
  );
  setHash(hash);
  render();
}
function selectSurvivor(id) {
  stopHistoryPlayback();
  state.selectedId = id; state.activePlaceIndex = null;
  state.explorePresentation = "auto";
  state.view = "explore"; setHash(`#/survivor/${id}`); render(true);
  document.getElementById("profile-name")?.focus({ preventScroll: true });
}
function clearSel() {
  const id = state.selectedId;
  state.selectedId = null; state.activePlaceIndex = null;
  state.explorePresentation = "auto";
  setHash(exploreHash()); render(true);
  restoreCollectionFocus(id);
}

function restoreCollectionFocus(id) {
  const source = id && document.querySelector(`[data-survivor="${CSS.escape(id)}"]`);
  (source || document.getElementById("search"))?.focus({ preventScroll: true });
}

function toggleGroup(name, checked) {
  if (!store.groups.some((group) => group.name === name)) {
    console.warn("The selected community is not in the collection.");
    return;
  }
  if (checked) state.groupFilter.add(name);
  else state.groupFilter.delete(name);
  state.railLimit = RAIL_PAGE;
  refreshCollection();
}

function setGroups(all) {
  state.groupFilter = new Set(all ? store.groups.map((group) => group.name) : []);
  state.railLimit = RAIL_PAGE;
  refreshCollection();
}

function resetSearch() {
  state.query = "";
  state.originCountry = null;
  state.groupFilter = new Set(store.groups.map((group) => group.name));
  state.railLimit = RAIL_PAGE;
  document.querySelector(".collection-filters").open = false;
  refreshCollection();
  if (!state.selectedId) history.replaceState(null, "", exploreHash());
  document.getElementById("search").focus();
}

function refreshCollection() {
  refreshRail(true);
  const search = document.getElementById("search");
  if (search.value !== state.query) search.value = state.query;
  document.querySelectorAll("[data-group]").forEach((input) => {
    input.checked = state.groupFilter.has(input.dataset.group);
  });
  document.querySelector("[data-group-count]").textContent = state.groupFilter.size === store.groups.length
    ? "All" : `${state.groupFilter.size} selected`;
  document.querySelector(".filter-reset").hidden = !state.query && !state.originCountry &&
    state.groupFilter.size === store.groups.length;
  document.querySelector("[data-origin-filter]").hidden = !state.originCountry;
  document.querySelector("[data-origin-name]").textContent = state.originCountry || "";
  atlas.render("explore", atlasCtx());
  updateBoundaryNotice();
}

function exploreHash() {
  const params = new URLSearchParams();
  if (state.originCountry) params.set("origin", state.originCountry);
  return `#/explore${params.size ? `?${params}` : ""}`;
}

function openOrigin(name) {
  if (!store.originCounts.has(name)) {
    console.warn("There are no mapped route origins for this country.");
    return;
  }
  stopHistoryPlayback();
  state.originCountry = name;
  state.query = "";
  state.groupFilter = new Set(store.groups.map((group) => group.name));
  state.railLimit = RAIL_PAGE;
  state.selectedId = null;
  state.activePlaceIndex = null;
  state.explorePresentation = "auto";
  state.view = "explore";
  setHash(exploreHash());
  render();
  document.getElementById("search").focus({ preventScroll: true });
}

function clearOrigin() {
  state.originCountry = null;
  state.railLimit = RAIL_PAGE;
  refreshCollection();
  if (!state.selectedId) history.replaceState(null, "", exploreHash());
  document.getElementById("search").focus({ preventScroll: true });
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
  updateBoundaryNotice();
}

function inspectAccountPlace(index) {
  const target = document.querySelector(`[data-place-step="${index}"]`);
  if (!target) {
    console.warn("The map reference has no matching account entry.");
    return;
  }
  if (MOBILE.matches && explorePresentation() === "map") setExplorePresentation("reader");
  focusPlace(index);
  scrollProfileTo(target.closest(".recorded-place"), target);
}

function scrollProfileTo(section, focusTarget = section) {
  const panel = document.querySelector(".panel");
  if (!section || !panel?.contains(section)) {
    console.warn("This section is not available in the selected account.");
    return;
  }
  const toolbar = panel.querySelector(".profile-toolbar");
  panel.scrollTo({
    top: section.getBoundingClientRect().top - panel.getBoundingClientRect().top +
      panel.scrollTop - toolbar.offsetHeight - 12,
    behavior: motionEnabled() ? "smooth" : "auto",
  });
  focusTarget.focus({ preventScroll: true });
}

function showInterviews() {
  scrollProfileTo(document.getElementById("profile-interviews"), document.getElementById("interviews-title"));
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
  scrollProfileTo(player, title);
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
  refreshCollection();
}
function showMore() {
  const previous = new Set([...document.querySelectorAll(".rail-card")].map((card) => card.dataset.survivor));
  state.railLimit += RAIL_PAGE * 2;
  refreshRail();
  const firstNew = [...document.querySelectorAll(".rail-card")].find((card) => !previous.has(card.dataset.survivor));
  firstNew?.focus({ preventScroll: true });
  firstNew?.scrollIntoView({ block: "nearest" });
}
function refreshRail(resetScroll = false) {
  const { html, shown, total } = ui.railInner(store, state);
  const list = document.querySelector("[data-rail-list]");
  const cnt = document.querySelector("[data-rail-count]");
  if (list) {
    list.innerHTML = html;
    if (resetScroll) list.scrollTop = 0;
  }
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
    focusMainContent();
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
  state.historyMatches = [];
  state.historySearchMessage = "";
  updateHistoryInfo();
  syncHistoryAddress();
  refreshPatternEvents();
  populateHistoryLocations();
  atlas.render("patterns", atlasCtx());
  updateBoundaryNotice();
  if (camera) atlas.focusCoordinates(camera.lng, camera.lat, camera.zoom, false);
}

function setPatternEvent(key) {
  const event = store.events.find((candidate) => candidate.key === key);
  if (!event) {
    console.warn("This dated place is not in the collection.");
    return;
  }
  state.scrubYear = event.year;
  state.patternEventKey = event.key;
  state.historyPlacesOpen = false;
  state.historyCountry = null;
  state.historyInfo = null;
  state.historyPlace = null;
  state.historyQuery = "";
  state.historyMatches = [];
  state.historySearchMessage = "";
  refreshHistorySearch();
  state.historyContextOpen = true;
  document.querySelector("[data-history-context]").open = true;
  stopHistoryPlayback();
  syncHistoryAddress();
  refreshPatternEvents();
  syncPresentation();
  atlas.render("patterns", atlasCtx());
  const title = document.getElementById("testimony-place-title");
  focusHistoryContent(title, title.closest(".testimony-moment"));
}

function focusHistoryContent(target, align = target) {
  const body = document.querySelector("[data-pattern-events]");
  if (!body || !target) {
    console.warn("The selected history detail is not available.");
    return;
  }
  body.scrollTop += align.getBoundingClientRect().top - body.getBoundingClientRect().top - 12;
  target.focus({ preventScroll: true });
}

function clearPatternEvent() {
  const previous = state.patternEventKey;
  state.patternEventKey = null;
  state.historyPlacesOpen = true;
  refreshPatternEvents();
  atlas.render("patterns", atlasCtx());
  focusHistoryContent(document.querySelector(`[data-event="${CSS.escape(previous || "")}"]`) ||
    document.querySelector("[data-history-place-list] > summary"));
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
  const control = document.activeElement.dataset.act;
  setPatternEvent(events[index].key);
  if (control === "prev-event" || control === "next-event") {
    document.querySelector(`[data-act="${control}"]`)?.focus({ preventScroll: true });
  }
}

function eventsForYear() {
  return store?.eventsByYear.get(state.scrubYear) || [];
}

function refreshPatternEvents(preserveReading = false) {
  const host = document.querySelector("[data-pattern-events]");
  if (host) {
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    const attribute = focused && ["id", "data-act", "data-event", "data-survivor", "href"]
      .find((name) => focused.hasAttribute(name));
    const selector = attribute ? `[${attribute}="${CSS.escape(focused.getAttribute(attribute))}"]`
      : focused?.matches(".country-heading h3") ? ".country-heading h3"
        : focused?.matches("summary") && focused.parentElement.classList.length
          ? `.${CSS.escape(focused.parentElement.classList[0])} > summary` : null;
    const focusOffset = focused ? focused.getBoundingClientRect().top - host.getBoundingClientRect().top : 0;
    const scroll = host.scrollTop;
    const disclosures = preserveReading ? [...host.querySelectorAll("details[class]")].map((details) => ({
      selector: `details.${CSS.escape(details.classList[0])}`, open: details.open,
    })) : [];
    host.innerHTML = ui.patternsEvents(store, state);
    if (preserveReading) {
      for (const disclosure of disclosures) {
        const details = host.querySelector(disclosure.selector);
        if (details) details.open = disclosure.open;
      }
      host.scrollTop = scroll;
      const target = selector && host.querySelector(selector);
      if (target) {
        host.scrollTop += target.getBoundingClientRect().top - host.getBoundingClientRect().top - focusOffset;
        target.focus({ preventScroll: true });
      } else if (focused) host.focus({ preventScroll: true });
    }
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
  if (!preserveReading) motion.animatePatternEvent();
}

function updateHistoryInfo() {
  const previous = state.historyInfo?.name || state.historyCountry;
  state.historyInfo = state.historyCountry ? atlas.countryInfo(state.historyCountry, state.scrubYear) : null;
  if (state.historyInfo) {
    state.historyCountry = state.historyInfo.controller;
    state.historyQuery = state.historyInfo.name;
    state.historySearchMessage = `Showing ${state.historyInfo.name} in ${state.scrubYear}.`;
  }
  if (state.historyCountry && !state.historyInfo && atlas.historyLoaded()) {
    state.historyCountry = null;
    state.historyQuery = "";
    state.historySearchMessage = `${previous} has no mapped territory in ${state.scrubYear}. The country selection has been cleared.`;
  } else if (state.historyPlace) {
    state.historySearchMessage = `Centred on ${state.historyPlace}. The border year is ${state.scrubYear}.`;
  }
  refreshHistorySearch();
}

function selectCountry(name, { openContext = true } = {}) {
  stopHistoryPlayback();
  state.pendingHistoryCamera = null;
  const info = name ? atlas.countryInfo(name, state.scrubYear) : null;
  if (name && !info) {
    state.historySearchMessage = `That administration is not mapped in ${state.scrubYear}. Try another year.`;
    refreshHistorySearch();
    return;
  }
  state.historyCountry = info?.controller || null;
  state.historyInfo = info;
  state.historyPlace = null;
  state.historyQuery = info?.name || "";
  state.historyMatches = [];
  state.historySearchMessage = info ? `Showing ${info.name} in ${state.scrubYear}.` : `Showing all mapped territories in ${state.scrubYear}.`;
  refreshHistorySearch();
  state.historyContextOpen = openContext;
  const disclosure = document.querySelector("[data-history-context]");
  if (disclosure) disclosure.open = openContext;
  state.patternEventKey = null;
  syncHistoryAddress();
  refreshPatternEvents();
  syncPresentation();
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
  const query = input.value.trim();
  stopHistoryPlayback();
  state.historyQuery = query;
  state.historyMatches = [];
  if (!query) {
    state.historySearchMessage = "Enter a country or a place named in an OHP account.";
    refreshHistorySearch();
    input.focus();
    return;
  }
  const matches = atlas.searchLocations(query, state.scrubYear);
  if (!matches.length) {
    state.historySearchMessage = atlas.historyLoaded()
      ? `No mapped country or OHP place matched "${query}" in ${state.scrubYear}. Try another name or year.`
      : "The historical borders have not loaded. Try a recorded place, or use the map's retry button.";
    refreshHistorySearch();
    atlas.resize();
    return;
  }
  const exact = matches.find((match) => match.exact);
  if (exact || matches.length === 1) return applyHistoryLocation(exact || matches[0]);
  state.historyMatches = matches;
  state.historySearchMessage = `${matches.length} locations match. Choose a territory or a recorded place.`;
  refreshHistorySearch();
  document.querySelector("[data-history-match]")?.focus({ preventScroll: true });
}

function applyHistoryLocation(match) {
  state.pendingHistoryCamera = null;
  state.historyQuery = match.name;
  state.historyMatches = [];
  if (match.kind === "country") selectCountry(match.name);
  else {
    state.historyPlace = match.name;
    state.historyCountry = null;
    state.historyInfo = null;
    state.historySearchMessage = `Centred on ${match.name}. The border year is ${state.scrubYear}.`;
    refreshHistorySearch();
    refreshPatternEvents();
    atlas.render("patterns", atlasCtx());
    atlas.focusCoordinates(match.lng, match.lat, 4);
    document.querySelector("[data-country-search]").focus({ preventScroll: true });
  }
  syncHistoryAddress();
}

function refreshHistorySearch() {
  const input = document.querySelector("[data-country-search]");
  if (!input) return;
  if (input.value !== state.historyQuery) input.value = state.historyQuery;
  document.querySelector("[data-search-status]").textContent = state.historySearchMessage;
  const results = document.querySelector("[data-history-results]");
  results.innerHTML = ui.historySearchResults(state.historyMatches, state.scrubYear);
  results.hidden = !state.historyMatches.length;
}

function onHistorySearch(value) {
  stopHistoryPlayback();
  state.historyQuery = value;
  state.historyMatches = [];
  if (!value.trim() && (state.historyCountry || state.historyPlace)) return selectCountry(null, { openContext: false });
  state.historySearchMessage = "";
  refreshHistorySearch();
}

function updateBoundaryNotice() {
  const notice = document.querySelector("[data-boundary-notice]");
  if (!notice) return;
  const year = atlasCtx().boundaryYear;
  const loadState = atlas.historyState();
  const visible = year != null && ["loading", "error"].includes(loadState);
  const message = loadState === "error"
    ? `The ${year} borders could not load. Showing today's basemap instead.`
    : `Loading ${year} borders. Today's basemap is shown for now.`;
  const visibilityChanged = notice.hidden === visible;
  const messageChanged = notice.querySelector("p").textContent !== message;
  notice.hidden = !visible;
  notice.querySelector("p").textContent = message;
  notice.querySelector("button").hidden = loadState !== "error";
  const caption = document.querySelector("[data-explore-map-caption]");
  const previousHeight = caption?.offsetHeight;
  if (caption) caption.innerHTML = ui.exploreMapCaption(store, state, atlas.historyLoaded());
  const comparisonChanged = updateCompareCaption();
  if (visibilityChanged || (visible && messageChanged) || caption?.offsetHeight !== previousHeight || comparisonChanged) {
    window.requestAnimationFrame(() => atlas.resize());
  }
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
  const frameChanged = updateCompareCaption();
  if (compare) compare.hidden = !state.historyCompare;
  atlas.setHistoryDisplay({
    compare: state.historyCompare, split: state.historySplit, opacity: state.historyOpacity,
  });
  if (frameChanged) atlas.resize();
  syncHistoryAddress();
}

function updateCompareCaption() {
  const caption = document.querySelector("[data-compare-caption]");
  if (!caption) return false;
  const hidden = !state.historyCompare || !atlas.historyLoaded();
  const changed = caption.hidden !== hidden;
  caption.hidden = hidden;
  return changed;
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
  document.getElementById("share-feedback").hidden = false;
  document.querySelector("[data-act='share-map']").setAttribute("aria-expanded", "true");
  status.textContent = "Copying the map link.";
  fallback.hidden = true;
  fallback.value = address;
  if (!navigator.clipboard) {
    fallback.hidden = false;
    fallback.select();
    status.textContent = "Copy this link to share the selected year and map layers.";
    return;
  }
  try {
    await navigator.clipboard.writeText(address);
    fallback.hidden = true;
    status.textContent = "The map link has been copied.";
  } catch (error) {
    if (!(error instanceof DOMException)) throw error;
    fallback.hidden = false;
    fallback.select();
    status.textContent = "Clipboard access was blocked. You can copy this link.";
  }
}

function closeShare(restoreFocus = true) {
  document.getElementById("share-feedback").hidden = true;
  document.querySelector("[data-share-address]").hidden = true;
  const button = document.querySelector("[data-act='share-map']");
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus) button.focus({ preventScroll: true });
}

// ---- event wiring ------------------------------------------------------------
function wireGlobal() {
  document.getElementById("topbar").addEventListener("click", onActivate);
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    focusMainContent();
  });
  document.addEventListener("pointerdown", (event) => {
    if (document.querySelector(".share-feedback:not([hidden])") &&
        !event.target.closest(".share-feedback,[data-act='share-map']")) closeShare(false);
    if (state.view === "patterns" && state.historyMatches.length && !event.target.closest(".history-search-box")) {
      state.historyMatches = [];
      state.historySearchMessage = "Search again to see matching locations.";
      refreshHistorySearch();
    }
  });
  document.addEventListener("visibilitychange", () => { if (document.hidden) stopHistoryPlayback(); });
  document.addEventListener("toggle", (event) => {
    if (event.target.matches("[data-history-place-list]")) state.historyPlacesOpen = event.target.open;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      const settings = document.querySelector(".history-settings[open]");
      if (state.view === "patterns" && state.historyMatches.length) {
        state.historyMatches = [];
        state.historySearchMessage = "Location suggestions closed.";
        refreshHistorySearch();
        document.querySelector("[data-country-search]").focus();
      } else if (settings) {
        settings.open = false;
        settings.querySelector("summary").focus();
      } else if (document.querySelector(".share-feedback:not([hidden])")) {
        closeShare();
      } else if (state.view === "patterns" && SHORT_VIEWPORT.matches && document.querySelector("[data-history-context]")?.open) {
        const context = document.querySelector("[data-history-context]");
        context.open = false;
        context.querySelector("summary").focus();
      } else if (state.historyPlaying) stopHistoryPlayback();
      else if (state.view === "patterns" && state.historyCountry) selectCountry(null, { openContext: false });
      else if (state.view === "about") go("explore");
      else if (state.view === "explore" && state.selectedId) clearSel();
    }
  });
}

function focusMainContent() {
  const selectors = state.view === "explore"
    ? ["#profile-name", "#search"]
    : state.view === "patterns"
      ? [".patterns-intro h2", "[data-country-search]", "[data-history-context] > summary"]
      : state.view === "about" ? [".about-header h1"]
        : state.view === "not-found" ? ["#missing-title"] : [".landing-card h1"];
  const target = selectors.map((selector) => document.querySelector(selector))
    .find((element) => element?.getClientRects().length) || document.getElementById("overlay");
  if (!target.matches("input,button,summary,[tabindex]")) target.tabIndex = -1;
  target.focus({ preventScroll: true });
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
    historySearch.querySelector("input").addEventListener("input", (event) => onHistorySearch(event.target.value));
    populateHistoryLocations();
  }
  host.querySelector("[data-history-context]")?.addEventListener("toggle", (event) => {
    state.historyContextOpen = event.target.open;
    syncPresentation();
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
  host.querySelector(".collection-filters")?.addEventListener("toggle", () => atlas.resize());
  host.querySelectorAll("[data-group]").forEach((input) => {
    input.addEventListener("change", () => toggleGroup(input.dataset.group, input.checked));
  });
}
function onActivate(e) {
  const t = e.target.closest("[data-act],[data-view],[data-survivor],[data-layer],[data-event],[data-place-step],[data-video],[data-profile-section],[data-origin],[data-history-match]");
  if (!t || !e.currentTarget.contains(t)) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.layer) return setLayer(t.dataset.layer);
  if (t.dataset.survivor != null) return selectSurvivor(t.dataset.survivor);
  if (t.dataset.profileSection) return scrollProfileTo(document.getElementById(t.dataset.profileSection));
  if (t.dataset.origin) return openOrigin(t.dataset.origin);
  if (t.dataset.historyMatch != null) {
    const match = state.historyMatches[Number(t.dataset.historyMatch)];
    if (match) return applyHistoryLocation(match);
    console.warn("This map search result is no longer available.");
    return;
  }
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
    case "all-groups": return setGroups(true);
    case "no-groups": return setGroups(false);
    case "close-filters":
      document.querySelector(".collection-filters").open = false;
      return document.querySelector(".collection-filters summary").focus();
    case "clear-origin": return clearOrigin();
    case "origin-overview": state.patternsLayer = "origins"; return go("patterns");
    case "show-interviews": return showInterviews();
    case "expand-reader": return toggleReader();
    case "show-explore-map": return setExplorePresentation("map");
    case "show-reader": return setExplorePresentation("reader");
    case "close-video": return closeVideo();
    case "zoom-in": state.pendingHistoryCamera = null; return atlas.zoomBy(1.5);
    case "zoom-out": state.pendingHistoryCamera = null; return atlas.zoomBy(1 / 1.5);
    case "reset-map":
      state.activePlaceIndex = null;
      state.pendingHistoryCamera = null;
      document.querySelectorAll("[data-place-step]").forEach((button) => button.setAttribute("aria-pressed", "false"));
      atlas.render(state.view, atlasCtx());
      updateBoundaryNotice();
      return atlas.resetCamera();
    case "prev-year": return stepEventYear(-1);
    case "next-year": return stepEventYear(1);
    case "prev-event": return stepPatternEvent(-1);
    case "next-event": return stepPatternEvent(1);
    case "clear-event": return clearPatternEvent();
    case "clear-country": return selectCountry(null);
    case "play-history": return toggleHistoryPlayback();
    case "share-map": return shareMap();
    case "close-share": return closeShare();
    case "retry-history": return atlas.retryHistory();
  }
}

// ---- routing -----------------------------------------------------------------
let programmatic = false;
function setHash(h) { programmatic = true; if (location.hash !== h) location.hash = h; else programmatic = false; }
function showMissing(kind) {
  state.missingKind = kind;
  state.view = "not-found";
  render();
  focusMainContent();
}

function route() {
  if (programmatic) { programmatic = false; return; }
  stopHistoryPlayback();
  const [hash, query = ""] = (location.hash || "").split("?");
  const params = new URLSearchParams(query);
  const [, kind, value] = hash.split("/");
  if (kind === "guided" || hash === "#map" || hash === "#overlay") {
    history.replaceState(null, "", "#/explore");
    state.view = "explore";
    state.selectedId = null;
    state.activePlaceIndex = null;
    state.explorePresentation = "auto";
    render();
    return;
  }
  if (kind === "survivor" && value && store.byId.has(value)) {
    state.selectedId = store.byId.get(value).id;
    state.activePlaceIndex = null;
    state.explorePresentation = "auto";
    state.view = "explore";
    if (state.selectedId !== value) history.replaceState(null, "", `#/survivor/${state.selectedId}`);
    render();
    return;
  }
  if (kind === "survivor") return showMissing("account");
  if (kind === "place" && value) {
    const found = store.journeys.find((j) => j.waypoints.some((w) => slug(w.canonical) === value));
    if (!found) return showMissing("place");
    state.view = "explore"; state.selectedId = found.id;
    state.activePlaceIndex = null; state.explorePresentation = "auto";
    render(); return;
  }
  if (kind === "place") return showMissing("place");
  if (kind === "patterns" && value && /^\d{4}$/.test(value)) {
    state.scrubYear = Math.max(store.time.min, Math.min(store.time.max, Number(value)));
    state.patternEventKey = null;
    state.patternsLayer = params.get("layer") === "origins" ? "origins" : "journeys";
    state.historyCountry = params.get("country") || null;
    state.historyInfo = null;
    state.historyQuery = state.historyCountry || "";
    state.historySearchMessage = "";
    state.historyMatches = [];
    state.historyPlace = null;
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
  if (VIEWS.includes(kind)) {
    if (kind === "patterns" && value) return showMissing("page");
    const previous = state.selectedId;
    if (kind === "explore") {
      state.selectedId = null;
      state.activePlaceIndex = null;
      state.originCountry = params.get("origin") || null;
      state.explorePresentation = "auto";
    }
    state.view = kind;
    render(kind === "explore");
    if (kind === "explore" && previous) restoreCollectionFocus(previous);
    return;
  }
  if (!hash || hash === "#" || hash === "#/") {
    state.view = "landing"; render();
  } else showMissing("page");
}

main();
