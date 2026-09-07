// app.js — orchestration. Owns the state machine, renders the persistent atlas
// (atlas.js) + the per-view overlay (ui.js), and wires collection, media and history controls.
import { loadData, journeyFilter, collectionResults, BiographyError } from "./data.js";
import { createAtlas } from "./atlas.js";
import * as ui from "./ui.js";
import * as motion from "./motion.js";
import { isReferenceKey, sourceReferenceTargets, referenceLink, ReferenceLinkError } from "./reference-links.js";
import { motionEnabled, onMotionPreferenceChange, slug, normalizeSearch } from "./config.js";
import { playerURL } from "./media.js";
import {
  SAVED_ACCOUNTS_KEY, readSavedAccounts, updateSavedAccount, isSavedAccountsFailure, copyText,
  addSavedAccounts, decodeCollectionIds, collectionLink, collectionCitations, CollectionLinkError, CitationError,
} from "./research-tools.js";

const VIEWS = ["landing", "explore", "patterns", "about", "not-found"];
const RAIL_PAGE = 140;
const MOBILE = window.matchMedia("(max-width: 820px)");
const SHORT_VIEWPORT = window.matchMedia("(max-width: 820px) and (max-height: 540px)");

const state = {
  view: "landing",
  selectedId: null,
  activePlaceIndex: null,
  referenceKey: null,
  referenceMessage: "",
  referenceResolving: false,
  explorePresentation: "auto",
  missingKind: null,
  query: "",
  groupFilter: new Set(),        // populated from the data (all on by default)
  originCountry: null,
  placeFilter: null,
  savedIds: new Set(),
  savedOnly: false,
  sharedIds: null,
  captionedOnly: false,
  savedError: "",
  citationDate: new Date(),
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
  historySpeed: 1,
  historyContextOpen: null,
  historyPlacesOpen: false,
  pendingHistoryCamera: null,
};

let store, atlas;
let historyTimer = null;
let readingListSnapshot = null;
let printJob = null;
let printReturnFocus = null;
let printMapSize = null;
let referenceRequest = 0;
let rendered = { view: null, selectedId: null, patternsLayer: null };

async function main() {
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const fatalEl = document.getElementById("fatal");
  const serverProfile = document.getElementById("server-profile");
  const serverId = serverProfile?.dataset.survivorId;
  const openingServerProfile = serverId && currentFragment().split("?")[0] === `#/survivor/${serverId}`;

  try {
    store = await loadData({ compact: true, onRetry: () => {
      loadingEl.querySelector(".loading-status").textContent = "Reconnecting to the archive";
    } });
  }
  catch (err) {
    loadingEl.hidden = true; fatalEl.hidden = false;
    if (openingServerProfile) showServerProfileRetry(serverProfile,
      "The interactive collection could not load. This account is still available below; you can retry the map or read the original source.");
    console.error(err); return;
  }
  if (openingServerProfile && !store.byId.has(serverId)) {
    loadingEl.hidden = true;
    showServerProfileRetry(serverProfile,
      "This account is available, but the interactive collection is still updating. Read its source summary below or try the interactive view again shortly.");
    console.warn("The server-validated account is not yet available in this collection index.");
    return;
  }
  loadingEl.querySelector(".loading-status").textContent = "Opening the map";
  loadSavedList();

  state.patternEventKey = null;
  store.groups.forEach((g) => state.groupFilter.add(g.name));
  atlas = createAtlas(document.getElementById("map"));
  atlas.setStore(store);
  atlas.setTooltipEl(document.getElementById("tip"));
  atlas.onUserCameraChange = () => { state.pendingHistoryCamera = null; };
  atlas.onHistoryStatus = () => {
    updateBoundaryNotice();
    refreshOpenFlagBrowser();
  };
  atlas.onHistoryReady = () => {
    updateBoundaryNotice();
    if (state.view !== "patterns") return;
    populateHistoryLocations();
    updateHistoryInfo();
    refreshPatternEvents(true);
    atlas.render("patterns", atlasCtx());
    restoreHistoryCamera();
    refreshOpenFlagBrowser();
  };

  try { await atlas.ready; }
  catch (err) {
    loadingEl.hidden = true; errorEl.hidden = false;
    if (openingServerProfile) showServerProfileRetry(serverProfile,
      "The interactive map could not load. This account is still available below; you can retry the map or read the original source.");
    console.error(err); return;
  }
  document.getElementById("topbar").hidden = false;
  motion.init();

  if (window.ResizeObserver) {
    let t;
    new ResizeObserver(([entry]) => {
      // Native print temporarily removes the map from layout; keep its camera intact.
      if (printJob || window.matchMedia("print").matches) return;
      if (printMapSize && entry.contentRect.width === printMapSize[0] && entry.contentRect.height === printMapSize[1]) {
        printMapSize = null;
        return;
      }
      printMapSize = null;
      clearTimeout(t);
      t = setTimeout(() => {
        if (printJob || window.matchMedia("print").matches) return;
        syncPresentation();
        atlas.resize();
        restoreHistoryCamera();
        keepHistoryFocusVisible();
      }, 120);
    })
      .observe(document.getElementById("map"));
  }

  wireGlobal();
  window.addEventListener("hashchange", route);
  route();
  document.getElementById("server-profile")?.remove();
  motion.animateShell();
  dismissLoading(loadingEl);
}

function showServerProfileRetry(profile, message) {
  profile.querySelector("[data-server-profile-status]").textContent = message;
  const retry = profile.querySelector("[data-server-profile-retry]");
  retry.hidden = false;
  retry.onclick = () => location.reload();
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
    onPlaceCluster: (canonical) => filterPlace(canonical),
    onMapFocus: (text) => { document.getElementById("map-announcement").textContent = text; },
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
  if (v === "landing" && !document.getElementById("portrait-field").hasChildNodes()) {
    document.getElementById("portrait-field").innerHTML = ui.livingMosaic(store);
  }
  document.querySelector(".skip-map").hidden = !["explore", "patterns"].includes(v);
  updateDocumentTitle();
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
    const journey = store.byId.get(state.selectedId);
    const miniEl = document.querySelector("[data-mini]");
    if (miniEl) atlas.drawMini(miniEl, journey);
    if (journey?.detailState === "ready" && state.referenceResolving && isReferenceKey(state.referenceKey)) {
      void restoreLinkedReference(journey);
    } else void loadSelectedProfile(state.selectedId);
  }
}

async function loadSelectedProfile(id, retry = false) {
  const journey = store.byId.get(id);
  if (!journey || journey.detailState === "ready" || journey.detailState === "loading" ||
      (journey.detailState === "error" && !retry)) return;
  try {
    const request = store.loadProfile(id);
    if (retry) refreshProfilePanel(journey);
    else document.querySelector(".panel").dataset.profileState = journey.detailState;
    await request;
    atlas.refreshJourney(journey);
  } catch (error) {
    journey.detailState = "error";
    journey.detailError = error.message;
    console.error("The selected account details could not load:", error);
  }
  if (state.view !== "explore" || state.selectedId !== id) return;
  refreshProfilePanel(journey);
  if (journey.detailState === "ready") {
    if (state.referenceResolving && isReferenceKey(state.referenceKey)) void restoreLinkedReference(journey);
    else if (state.activePlaceIndex != null && !state.referenceKey) void rememberReference(journey, state.activePlaceIndex);
  } else if (state.referenceKey) {
    state.referenceMessage = "Load this account's details to open the linked source reference.";
    refreshReferenceControls();
  }
}

function refreshProfilePanel(journey) {
  const panel = document.querySelector(".panel");
  const template = document.createElement("template");
  template.innerHTML = ui.panel(store, state);
  const fresh = template.content.querySelector(".panel");
  const focused = document.activeElement;
  const content = panel.querySelector(".profile-content");
  const contentFocused = content.contains(focused);
  const attribute = contentFocused && ["id", "data-place-step", "data-act"]
    .find((name) => focused.hasAttribute(name));
  const selector = attribute ? `[${attribute}="${CSS.escape(focused.getAttribute(attribute))}"]` : "#profile-name";
  const scroll = panel.scrollTop;

  // Keep navigation, saved tools, rail and map nodes stable during a detail fetch.
  const nextContent = fresh.querySelector(".profile-content");
  content.replaceWith(nextContent);
  panel.dataset.profileState = journey.detailState;
  panel.setAttribute("aria-busy", fresh.getAttribute("aria-busy"));
  panel.querySelector("[data-act='print-account']").disabled = journey.detailState !== "ready";
  panel.querySelector(".profile-route-status").textContent = fresh.querySelector(".profile-route-status").textContent;
  const nav = panel.querySelector(".profile-nav");
  for (const button of fresh.querySelectorAll("[data-profile-section]")) {
    if (nav.querySelector(`[data-profile-section="${button.dataset.profileSection}"]`)) continue;
    const following = [...button.parentElement.children].slice([...button.parentElement.children].indexOf(button) + 1)
      .map(item => nav.querySelector(`[data-profile-section="${item.dataset.profileSection}"]`)).find(Boolean);
    nav.insertBefore(button, following || null);
  }
  const interview = fresh.querySelector(".interview-action");
  if (interview && !panel.querySelector(".interview-action")) panel.querySelector(".profile-actions").prepend(interview);
  wireImages(nextContent);
  atlas.refreshJourney(journey, { miniEl: panel.querySelector("[data-mini]") });
  panel.scrollTop = scroll;
  if (contentFocused) (panel.querySelector(selector) || panel.querySelector("#profile-story")).focus({ preventScroll: true });
}

function filterPlace(canonical) {
  resetReferenceState();
  state.placeFilter = canonical;
  state.selectedId = null;
  state.activePlaceIndex = null;
  state.railLimit = RAIL_PAGE;
  state.explorePresentation = "auto";
  setHash(exploreHash());
  render(true);
  document.getElementById("search").focus({ preventScroll: true });
}

function focusMap() {
  if (state.view === "explore" && explorePresentation() === "reader") setExplorePresentation("map");
  const context = document.querySelector("[data-history-context]");
  if (state.view === "patterns" && SHORT_VIEWPORT.matches && context?.open) {
    context.open = false;
    state.historyContextOpen = false;
    syncPresentation();
    atlas.resize();
  }
  atlas.focusMap();
}

function explorePresentation() {
  if (state.explorePresentation === "map") return "map";
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
  syncHistoryAddress(true);
  if (view === "explore") {
    resetReferenceState();
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
function selectSurvivor(id, keepPresentation = false) {
  resetReferenceState();
  stopHistoryPlayback();
  syncHistoryAddress(true);
  if (state.view !== "explore") {
    state.query = "";
    state.originCountry = null;
    state.placeFilter = null;
    state.groupFilter = new Set(store.groups.map((group) => group.name));
    state.railLimit = RAIL_PAGE;
    state.savedOnly = false;
    state.sharedIds = null;
    state.captionedOnly = false;
  }
  state.selectedId = id; state.activePlaceIndex = null;
  if (!keepPresentation) state.explorePresentation = "auto";
  state.view = "explore"; setHash(accountHash(id)); render(true);
  document.getElementById("profile-name")?.focus({ preventScroll: true });
}

function navigateAccount(direction) {
  const results = collectionResults(store, state);
  const index = results.findIndex((journey) => journey.id === state.selectedId);
  const next = index >= 0 ? results[index + direction] : null;
  if (!next) {
    console.warn("There is no account in that direction within the current results.");
    return;
  }
  state.railLimit = Math.max(state.railLimit, Math.ceil((index + direction + 1) / RAIL_PAGE) * RAIL_PAGE);
  selectSurvivor(next.id, true);
}

function loadSavedList() {
  try {
    state.savedIds = readSavedAccounts(window.localStorage, store.byId);
    state.savedError = "";
  } catch (error) {
    if (!isSavedAccountsFailure(error)) throw error;
    state.savedError = "Saved accounts could not be read. Browser storage may be blocked or the list may be damaged.";
    console.warn("Unable to read saved accounts:", error.message);
  }
}

function refreshResearchTools(message = "") {
  for (const button of document.querySelectorAll("[data-save-id]")) {
    const journey = store.byId.get(button.dataset.saveId);
    const saved = state.savedIds.has(journey.id);
    const label = saved ? `Remove ${journey.name} from saved accounts` : `Save ${journey.name} for later`;
    button.setAttribute("aria-pressed", String(saved));
    button.setAttribute("aria-label", label);
    button.title = label;
    const text = button.querySelector("span");
    if (text) text.textContent = saved ? "Saved account" : "Save account";
  }
  const savedView = document.querySelector(".saved-view");
  if (savedView) {
    savedView.innerHTML = ui.savedViewLabel(store, state);
    document.querySelector("[data-collection-title]").textContent = ui.collectionTitle(state);
    document.querySelector("[data-saved-privacy]").hidden = !state.savedOnly;
  }
  const listTools = document.querySelector("[data-reading-list-tools]");
  if (listTools) {
    listTools.hidden = !state.savedOnly && !state.sharedIds;
    listTools.innerHTML = ui.readingListTools(store, state);
  }
  for (const feedback of document.querySelectorAll("[data-saved-feedback], [data-account-saved-feedback]")) {
    feedback.textContent = state.savedError || message;
    feedback.hidden = !feedback.textContent;
  }
  document.querySelectorAll("[data-result-navigation]").forEach((navigation) => {
    navigation.innerHTML = ui.resultNavigation(store, state);
  });
  const related = document.querySelector("[data-related-reading]");
  if (related && store.byId.get(state.selectedId)?.detailState === "ready") {
    related.innerHTML = ui.relatedReading(store, state);
    wireImages(related);
  }
}

function toggleSavedAccount(id) {
  const saved = !state.savedIds.has(id);
  const source = document.activeElement;
  const fromPanel = Boolean(source.closest(".panel"));
  let message = "";
  try {
    state.savedIds = updateSavedAccount(window.localStorage, store.byId, id, saved);
    state.savedError = "";
    message = saved ? "Saved on this browser for later." : "Removed from this browser's saved accounts.";
  } catch (error) {
    if (!isSavedAccountsFailure(error)) throw error;
    state.savedError = "The saved list could not be changed. Allow browser storage or copy the account link instead.";
    console.warn("Unable to change saved accounts:", error.message);
  }
  const list = document.querySelector("[data-rail-list]");
  const scroll = list?.scrollTop || 0;
  if (state.savedOnly) refreshRail();
  if (list) list.scrollTop = scroll;
  refreshResearchTools(message);
  atlas.render("explore", atlasCtx());
  const selector = `${fromPanel ? ".panel" : ".rail"} [data-save-id="${CSS.escape(id)}"]`;
  (document.querySelector(selector) || document.querySelector(".saved-view"))?.focus({ preventScroll: true });
}

function toggleSavedView() {
  if (state.sharedIds) return leaveSharedList();
  loadSavedList();
  state.savedOnly = !state.savedOnly;
  state.query = "";
  state.originCountry = null;
  state.placeFilter = null;
  state.captionedOnly = false;
  state.groupFilter = new Set(store.groups.map((group) => group.name));
  state.railLimit = RAIL_PAGE;
  document.querySelector(".collection-filters").open = false;
  refreshCollection();
  document.querySelector(".saved-view").focus({ preventScroll: true });
}

function leaveSharedList() {
  resetReferenceState();
  state.sharedIds = null;
  state.savedOnly = false;
  state.selectedId = null;
  state.activePlaceIndex = null;
  state.explorePresentation = "auto";
  state.query = "";
  state.originCountry = null;
  state.placeFilter = null;
  state.captionedOnly = false;
  state.groupFilter = new Set(store.groups.map(group => group.name));
  state.railLimit = RAIL_PAGE;
  setHash(exploreHash());
  render();
  document.getElementById("search").focus({ preventScroll: true });
}

function saveSharedList() {
  const ids = collectionResults(store, state).map(journey => journey.id);
  try {
    state.savedIds = addSavedAccounts(window.localStorage, store.byId, ids);
    state.savedError = "";
    refreshResearchTools(`${ids.length} ${ids.length === 1 ? "account is" : "accounts are"} saved in this browser. Your other saved accounts have been kept.`);
  } catch (error) {
    if (!isSavedAccountsFailure(error)) throw error;
    state.savedError = "This list could not be saved. Your existing saved accounts have not been changed.";
    console.warn("Unable to add this reading list:", error.message);
    refreshResearchTools();
  }
  document.getElementById("search").focus({ preventScroll: true });
}

function openResearchDialog(markup, returnAction) {
  const template = document.createElement("template");
  template.innerHTML = markup;
  const dialog = template.content.querySelector("dialog");
  dialog.dataset.returnAction = returnAction;
  document.getElementById("overlay").append(dialog);
  dialog.addEventListener("close", () => {
    const connected = dialog.isConnected;
    if (dialog.id === "reading-list-dialog") readingListSnapshot = null;
    dialog.remove();
    if (connected) {
      const opener = document.querySelector(`[data-act="${returnAction}"]`);
      (opener && !opener.disabled ? opener : document.getElementById("search"))?.focus({ preventScroll: true });
    }
  }, { once: true });
  dialog.showModal();
  return dialog;
}

async function fillBiographyDialog(dialog, journey) {
  const content = dialog.querySelector("[data-biography-content]");
  const focusedRetry = document.activeElement?.dataset.act === "retry-biography";
  const request = store.loadBiography(journey.id);
  content.innerHTML = ui.biographyContent(journey);
  dialog.setAttribute("aria-busy", String(journey.biographyState === "loading"));
  try { await request; }
  catch (error) {
    if (!(error instanceof BiographyError)) throw error;
    journey.biographyState = "error";
    journey.biographyError = error.message;
    console.warn("The full source biography could not load:", error.message);
  }
  if (!dialog.isConnected || dialog.dataset.survivorId !== journey.id) return;
  content.innerHTML = ui.biographyContent(journey);
  dialog.setAttribute("aria-busy", "false");
  dialog.querySelector("[data-act='print-account']").disabled = journey.biographyState !== "ready";
  if (focusedRetry) (content.querySelector(".full-biography-text") || content.querySelector("button"))?.focus({ preventScroll: true });
}

function openBiography() {
  const journey = store.byId.get(state.selectedId);
  if (journey?.detailState !== "ready") {
    console.warn("Load the account details before opening its source biography.");
    refreshResearchTools("Wait for the account details to load before opening the full biography.");
    return;
  }
  const dialog = openResearchDialog(ui.biographyDialog(journey), "read-full-biography");
  dialog.dataset.survivorId = journey.id;
  if (journey.biographyState !== "ready") void fillBiographyDialog(dialog, journey);
}

function wireDirectoryNavigation(dialog, input, selector) {
  const buttons = () => [...dialog.querySelectorAll(selector)].filter(button => !button.closest("[hidden]"));
  const activate = button => {
    dialog.querySelectorAll(selector).forEach(item => { item.tabIndex = item === button ? 0 : -1; });
  };
  dialog.addEventListener("focusin", event => {
    const button = event.target.closest(selector);
    if (button) activate(button);
  });
  dialog.addEventListener("keydown", event => {
    if (event.ctrlKey || event.altKey || event.metaKey || event.isComposing) return;
    const visible = buttons();
    if (!visible.length) return;
    const button = event.target.closest(selector);
    if (event.target === input && ["ArrowDown", "Enter"].includes(event.key)) {
      event.preventDefault();
      activate(visible[0]); visible[0].focus();
    } else if (button && ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const index = visible.indexOf(button);
      const next = event.key === "Home" ? 0 : event.key === "End" ? visible.length - 1
        : Math.max(0, Math.min(visible.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
      activate(visible[next]);
      visible[next].focus({ preventScroll: true });
      visible[next].scrollIntoView({ block: "nearest" });
    }
  });
  return { buttons, activate };
}

function openPlaceBrowser() {
  const dialog = openResearchDialog(ui.placeBrowser(store, state), "browse-places");
  const input = dialog.querySelector("#place-directory-search");
  const navigation = wireDirectoryNavigation(dialog, input, "[data-browse-place]");
  const filter = () => {
    const query = normalizeSearch(input.value);
    dialog.querySelectorAll("[data-directory-row]").forEach(row => { row.hidden = !row.dataset.placeSearch.includes(query); });
    const visible = navigation.buttons();
    navigation.activate(visible[0]);
    dialog.querySelector("[data-directory-count]").textContent = `${visible.length} ${visible.length === 1 ? "place name" : "place names"}`;
    dialog.querySelector("[data-directory-empty]").hidden = visible.length > 0;
  };
  input.addEventListener("input", filter);
  filter();
}

function openFlagBrowser() {
  stopHistoryPlayback();
  const dialog = openResearchDialog(ui.flagBrowser(state.scrubYear, store.time.min, store.time.max), "browse-flags");
  const input = dialog.querySelector("#flag-directory-search");
  const navigation = wireDirectoryNavigation(dialog, input, "[data-flag-summary]");
  input.addEventListener("input", () => {
    const query = normalizeSearch(input.value);
    const rows = [...dialog.querySelectorAll("[data-flag-row]")];
    for (const row of rows) row.hidden = !row.dataset.flagSearch.includes(query);
    const visible = rows.filter(row => !row.hidden);
    const dated = visible.filter(row => row.dataset.flagAvailable === "true").length;
    navigation.activate(navigation.buttons()[0]);
    dialog.querySelector("[data-flag-count]").textContent =
      dialog.dataset.currentReferences === "true"
        ? `${visible.length} of ${rows.length} countries and territories. ${dated} current reference images.`
        : `${visible.length} of ${rows.length} entries. ${dated} ${dated === 1 ? "dated flag" : "dated flags"} for ${state.scrubYear}.`;
    dialog.querySelector("[data-flag-empty]").hidden = visible.length > 0 || rows.length === 0;
  });
  dialog.querySelector("#flag-directory-year").addEventListener("change", event => {
    dialog.dataset.currentReferences = String(event.target.value === "current");
    if (event.target.value === "current") refreshOpenFlagBrowser();
    else setScrub(Number(event.target.value));
  });
  dialog.addEventListener("toggle", event => {
    if (event.target.matches("[data-flag-row]") && event.target.open && event.target.contains(document.activeElement)) {
      event.target.querySelector("summary").scrollIntoView({ block: "nearest" });
    }
  }, true);
  refreshOpenFlagBrowser();
}

function refreshOpenFlagBrowser() {
  const dialog = document.querySelector("#flag-browser[open]");
  if (!dialog) return;
  const body = dialog.querySelector(".research-dialog-body");
  const scroll = body.scrollTop;
  const opened = new Set([...dialog.querySelectorAll("[data-flag-row][open]")].map(row => row.dataset.flagName));
  const focused = dialog.contains(document.activeElement) ? document.activeElement.closest("[data-flag-row]")?.dataset.flagName : null;
  const href = focused && document.activeElement.getAttribute("href");
  const current = dialog.dataset.currentReferences === "true";
  const year = current ? store.time.max : state.scrubYear;
  dialog.querySelector("#flag-directory-year").value = current ? "current" : state.scrubYear;
  dialog.querySelector("[data-flag-directory]").innerHTML = ui.flagDirectory(atlas.flagCountries(year), year, atlas.historyState(), current);
  for (const row of dialog.querySelectorAll("[data-flag-row]")) row.open = opened.has(row.dataset.flagName);
  const input = dialog.querySelector("#flag-directory-search");
  input.dispatchEvent(new Event("input"));
  body.scrollTop = scroll;
  wireImages(dialog);
  if (focused) {
    const row = [...dialog.querySelectorAll("[data-flag-row]:not([hidden])")].find(entry => entry.dataset.flagName === focused);
    const target = row && (href ? [...row.querySelectorAll("a")].find(link => link.getAttribute("href") === href) : row.querySelector("summary"));
    (target || input).focus({ preventScroll: true });
  }
}

function refreshOpenPlaceBrowser() {
  const dialog = document.querySelector("#place-browser[open]");
  if (!dialog) return;
  const focusedPlace = dialog.contains(document.activeElement) ? document.activeElement.dataset.browsePlace : null;
  const body = dialog.querySelector(".research-dialog-body");
  const scroll = body.scrollTop;
  const template = document.createElement("template");
  template.innerHTML = ui.placeBrowser(store, state);
  dialog.querySelector(".place-directory-list").replaceChildren(...template.content.querySelector(".place-directory-list").children);
  dialog.querySelector("[data-directory-empty]").textContent = template.content.querySelector("[data-directory-empty]").textContent;
  const input = dialog.querySelector("#place-directory-search");
  input.dispatchEvent(new Event("input"));
  body.scrollTop = scroll;
  if (focusedPlace) {
    const target = [...dialog.querySelectorAll("[data-directory-row]:not([hidden]) button")]
      .find(button => button.dataset.browsePlace === focusedPlace);
    (target || input).focus({ preventScroll: true });
  }
}

function shareReadingList() {
  const journeys = collectionResults(store, state).map(({ id, name, archiveUrl }) => ({ id, name, archiveUrl }));
  if (!journeys.length) {
    console.warn("There are no matching accounts to share.");
    refreshResearchTools("There are no accounts in the current selection to share.");
    return;
  }
  let url = "", message = "";
  try { url = collectionLink(journeys.map(journey => journey.id), location.href); }
  catch (error) {
    if (!(error instanceof CollectionLinkError)) throw error;
    message = error.message;
    console.warn("The reading-list link could not be created:", message);
  }
  readingListSnapshot = { journeys, accessed: new Date() };
  openResearchDialog(ui.readingListDialog(journeys, url, message), "share-reading-list");
}

async function copyReadingList() {
  const dialog = document.getElementById("reading-list-dialog");
  const field = dialog.querySelector("#reading-list-address");
  const copied = await copyText(field.value, navigator.clipboard);
  if (!dialog.isConnected) return;
  if (!copied) { field.focus(); field.select(); }
  dialog.querySelector("[data-reading-list-status]").textContent = copied ? "Reading-list link copied."
    : "Copying is unavailable. The link is selected so you can copy it yourself.";
}

function downloadListSources(fromDialog = false) {
  const journeys = fromDialog ? readingListSnapshot?.journeys : collectionResults(store, state);
  const feedback = fromDialog ? document.querySelector("[data-reading-list-status]") : document.querySelector("[data-saved-feedback]");
  let text;
  try { text = collectionCitations(journeys || [], fromDialog ? readingListSnapshot.accessed : new Date()); }
  catch (error) {
    if (!(error instanceof CitationError)) throw error;
    feedback.hidden = false;
    feedback.textContent = error.message;
    console.warn("Source citations could not be prepared:", error.message);
    return;
  }
  downloadFile(new Blob([text], { type: "text/plain;charset=utf-8" }), "ohp-reading-list-sources.txt");
  feedback.hidden = false;
  feedback.textContent = `Source citations prepared for ${journeys.length} ${journeys.length === 1 ? "account" : "accounts"}.`;
}

function preparePrintSheet() {
  const dialog = document.querySelector(".research-dialog[open]");
  if (!printJob) {
    if (dialog?.id === "reading-list-dialog" && readingListSnapshot) {
      printJob = { type: "list", ...readingListSnapshot };
    } else if (state.view === "explore" && state.selectedId) {
      printJob = { type: "account", journey: store.byId.get(state.selectedId), accessed: new Date() };
    } else if (state.view === "explore" && (state.savedOnly || state.sharedIds)) {
      printJob = {
        type: "list", journeys: collectionResults(store, state), accessed: new Date(),
        missing: state.sharedIds ? [...state.sharedIds].filter(id => !store.byId.has(id)).length : 0,
      };
    } else return;
  }
  if (!printReturnFocus) printReturnFocus = document.activeElement;
  if (!printMapSize) {
    const rect = document.getElementById("map").getBoundingClientRect();
    if (rect.width && rect.height) printMapSize = [rect.width, rect.height];
  }
  if (dialog) {
    printReturnFocus = document.querySelector(`[data-act="${dialog.dataset.returnAction}"]`);
    dialog.close();
  }
  let sheet = document.getElementById("print-sheet");
  if (!sheet) {
    sheet = document.createElement("section");
    sheet.id = "print-sheet";
    document.body.append(sheet);
  }
  sheet.innerHTML = printJob.type === "account"
    ? ui.printAccount(printJob.journey, location.href, printJob.accessed)
    : ui.printReadingList(printJob.journeys, location.href, printJob.accessed, printJob.missing || 0);
  const footer = sheet.querySelector(".print-footer").textContent.replace(/\s+/g, " ").trim();
  const pageStyles = document.createElement("style");
  pageStyles.textContent = `@media print { @page { @bottom-left { content:${JSON.stringify(footer)}; font:7.5pt "Public Sans", sans-serif; } } }`;
  sheet.append(pageStyles);
  sheet.querySelectorAll("img").forEach(image => image.addEventListener("error", () => {
    image.closest("figure").remove();
    console.warn("The portrait could not be included in this reading sheet.");
  }, { once: true }));
}

function finishPrinting() {
  document.getElementById("print-sheet")?.remove();
  printJob = null;
  if (printReturnFocus?.isConnected && !printReturnFocus.disabled) printReturnFocus.focus({ preventScroll: true });
  printReturnFocus = null;
}

function printAccount() {
  const journey = store.byId.get(state.selectedId);
  if (journey?.detailState !== "ready") {
    console.warn("The complete account must load before printing a reading sheet.");
    refreshResearchTools("Wait for the account details to load before printing.");
    return;
  }
  printJob = { type: "account", journey, accessed: new Date() };
  preparePrintSheet();
  window.print();
}

function printReadingList() {
  if (!readingListSnapshot) {
    console.warn("Open a reading list before printing its sources.");
    refreshResearchTools("Open Share list to choose the accounts to print.");
    return;
  }
  printJob = { type: "list", ...readingListSnapshot };
  preparePrintSheet();
  window.print();
}

function resetSavedList() {
  if (!window.confirm("Remove this browser's saved-account list? This cannot be undone.")) return;
  try {
    window.localStorage.removeItem(SAVED_ACCOUNTS_KEY);
    state.savedIds = new Set();
    state.savedError = "";
  } catch (error) {
    if (!isSavedAccountsFailure(error)) throw error;
    state.savedError = "The saved list could not be reset. Browser storage is unavailable.";
    console.warn("Unable to reset saved accounts:", error.message);
  }
  refreshCollection();
  document.querySelector(".saved-view").focus({ preventScroll: true });
}
function clearSel() {
  resetReferenceState();
  const id = state.selectedId;
  state.selectedId = null; state.activePlaceIndex = null;
  state.explorePresentation = "auto";
  setHash(exploreHash()); render(true);
  restoreCollectionFocus(id);
}

function restoreCollectionFocus(id) {
  const source = id && document.querySelector(`[data-survivor="${CSS.escape(id)}"]`);
  (source || document.getElementById("search"))?.focus({ preventScroll: true });
  source?.scrollIntoView({ block: "nearest" });
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
  if (state.savedOnly && !store.journeys.some((journey) => state.savedIds.has(journey.id))) state.savedOnly = false;
  state.query = "";
  state.originCountry = null;
  state.placeFilter = null;
  state.captionedOnly = false;
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
  document.querySelector("[data-group-count]").textContent = ui.filterSummary(store, state);
  document.querySelector("[data-caption-filter]").checked = state.captionedOnly;
  document.querySelector("[data-caption-count]").textContent = ui.captionedResultCount(store, state);
  document.querySelector(".filter-reset").hidden = !state.query && !state.originCountry &&
    !state.placeFilter && !state.captionedOnly && state.groupFilter.size === store.groups.length;
  document.querySelector("[data-origin-filter]").hidden = !state.originCountry;
  document.querySelector("[data-origin-name]").textContent = state.originCountry || "";
  document.querySelector("[data-place-filter]").hidden = !state.placeFilter;
  document.querySelector("[data-place-filter-name]").textContent = state.placeFilter || "";
  refreshResearchTools();
  atlas.render("explore", atlasCtx());
  updateBoundaryNotice();
  syncCollectionAddress();
}

function collectionAddress(prefix) {
  const params = new URLSearchParams();
  if (state.query.trim()) params.set("q", state.query.trim());
  if (state.groupFilter.size !== store.groups.length) {
    params.set("groups", store.groups.filter((group) => state.groupFilter.has(group.name))
      .map((group) => slug(group.name)).join(","));
  }
  if (state.originCountry) params.set("origin", state.originCountry);
  if (state.placeFilter) params.set("place", state.placeFilter);
  if (state.captionedOnly) params.set("captions", "1");
  if (state.savedOnly) params.set("saved", "1");
  if (state.sharedIds) params.set("list", [...state.sharedIds].join(","));
  if (prefix.startsWith("#/survivor/") && state.referenceKey !== null) params.set("ref", state.referenceKey);
  if (state.railLimit > RAIL_PAGE) params.set("limit", Math.min(state.railLimit, store.journeys.length));
  const query = params.toString();
  return `${prefix}${query ? `?${query}` : ""}`;
}

function exploreHash() { return collectionAddress("#/explore"); }
function accountHash(id) { return collectionAddress(`#/survivor/${id}`); }

function syncCollectionAddress() {
  if (state.view === "explore") {
    const fragment = state.selectedId ? accountHash(state.selectedId) : exploreHash();
    if (pathProfileId() && !location.hash && state.selectedId) {
      const separator = fragment.indexOf("?");
      history.replaceState(null, "", `/survivor/${state.selectedId}${separator < 0 ? "" : fragment.slice(separator)}`);
    } else history.replaceState(null, "", fragment);
    updateDocumentTitle();
  }
}

function restoreCollectionAddress(params) {
  const groups = new Map(store.groups.map((group) => [slug(group.name), group.name]));
  const requested = params.has("groups")
    ? (params.get("groups") ? params.get("groups").split(",") : []) : [...groups.keys()];
  const limit = params.has("limit") ? Number(params.get("limit")) : RAIL_PAGE;
  if (requested.some((group) => !groups.has(group)) || !Number.isSafeInteger(limit) || limit < RAIL_PAGE) {
    return false;
  }
  if (params.has("saved") && params.get("saved") !== "1") return false;
  if (params.has("captions") && params.get("captions") !== "1") return false;
  if (params.has("saved") && params.has("list")) return false;
  let sharedIds = null;
  try { if (params.has("list")) sharedIds = decodeCollectionIds(params.get("list"), store.byId); }
  catch (error) {
    if (!(error instanceof CollectionLinkError)) throw error;
    console.warn("The shared reading list could not be opened:", error.message);
    return false;
  }
  state.query = (params.get("q") || "").trim();
  state.groupFilter = new Set(requested.map((group) => groups.get(group)));
  state.originCountry = (params.get("origin") || "").trim() || null;
  state.placeFilter = (params.get("place") || "").trim() || null;
  state.savedOnly = params.get("saved") === "1";
  state.sharedIds = sharedIds;
  state.captionedOnly = params.get("captions") === "1";
  state.railLimit = Math.max(RAIL_PAGE, Math.min(limit, store.journeys.length));
  return true;
}

function openOrigin(name) {
  if (!store.originCounts.has(name)) {
    console.warn("There are no mapped route origins for this country.");
    return;
  }
  stopHistoryPlayback();
  resetReferenceState();
  state.originCountry = name;
  state.placeFilter = null;
  state.savedOnly = false;
  state.sharedIds = null;
  state.captionedOnly = false;
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

function resetReferenceState() {
  referenceRequest++;
  state.referenceKey = null;
  state.referenceMessage = "";
  state.referenceResolving = false;
  state.activePlaceIndex = null;
}

function refreshReferenceControls() {
  document.querySelectorAll("[data-place-step]").forEach(button => {
    button.setAttribute("aria-pressed", String(Number(button.dataset.placeStep) === state.activePlaceIndex));
  });
  document.querySelectorAll("[data-reference-actions]").forEach(actions => {
    actions.hidden = Number(actions.dataset.referenceActions) !== state.activePlaceIndex;
  });
  const notice = document.querySelector("[data-reference-notice]");
  if (notice) {
    notice.hidden = !state.referenceMessage;
    notice.innerHTML = ui.referenceNotice(state);
  }
}

async function rememberReference(journey, index) {
  const request = ++referenceRequest;
  try {
    const targets = await sourceReferenceTargets(journey.sourceProperties);
    const target = targets.find(item => item.collection === "waypoints" && item.index === index);
    if (!target || targets.filter(item => item.key === target.key).length !== 1) {
      throw new ReferenceLinkError("Several source entries share this identity. Copy the account link instead.");
    }
    if (request !== referenceRequest || state.view !== "explore" || state.selectedId !== journey.id || state.activePlaceIndex !== index) return;
    state.referenceKey = target.key;
    state.referenceMessage = "";
    syncCollectionAddress();
    refreshReferenceControls();
  } catch (error) {
    if (!(error instanceof ReferenceLinkError)) throw error;
    if (request !== referenceRequest || state.selectedId !== journey.id) return;
    state.referenceMessage = error.message;
    console.warn("This source reference could not be linked:", error.message);
    refreshReferenceControls();
  }
}

async function restoreLinkedReference(journey) {
  const key = state.referenceKey, request = ++referenceRequest;
  try {
    const targets = (await sourceReferenceTargets(journey.sourceProperties)).filter(target => target.key === key);
    if (request !== referenceRequest || state.view !== "explore" || state.selectedId !== journey.id || state.referenceKey !== key) return;
    state.referenceResolving = false;
    if (targets.length !== 1) {
      throw new ReferenceLinkError(targets.length
        ? "Several source entries match this link. Choose a reference below rather than assuming which one was intended."
        : "This reference no longer matches the current source. The account remains available; choose a recorded place below.");
    }
    const target = targets[0];
    if (target.collection === "waypoints") {
      state.referenceMessage = "";
      focusPlace(target.index, false);
      const button = document.querySelector(`[data-place-step="${target.index}"]`);
      scrollProfileTo(button.closest(".recorded-place"), button, false);
    } else {
      state.activePlaceIndex = null;
      state.referenceMessage = "This linked mention is now kept as source context, not this person's mapped journey.";
      const context = document.querySelector("details.contextual-places");
      context.open = true;
      const entry = context.querySelector(`[data-context-places~="${target.index}"]`);
      scrollProfileTo(entry, entry, false);
      atlas.render("explore", atlasCtx());
    }
    refreshReferenceControls();
  } catch (error) {
    if (!(error instanceof ReferenceLinkError)) throw error;
    if (request !== referenceRequest || state.selectedId !== journey.id) return;
    state.referenceResolving = false;
    state.referenceMessage = error.message;
    console.warn("The linked source reference could not be resolved:", error.message);
    refreshReferenceControls();
  }
}

async function copyReference(index) {
  const journey = store.byId.get(state.selectedId);
  const actions = document.querySelector(`[data-reference-actions="${index}"]`);
  if (journey?.detailState !== "ready" || !actions) {
    console.warn("Load and select a recorded reference before copying its link.");
    return;
  }
  const feedback = actions.querySelector("[data-reference-copy-status]");
  try {
    const targets = await sourceReferenceTargets(journey.sourceProperties);
    const target = targets.find(item => item.collection === "waypoints" && item.index === index);
    if (!target || targets.filter(item => item.key === target.key).length !== 1) {
      throw new ReferenceLinkError("This reference is not uniquely identified. Use Share & cite to copy the account link.");
    }
    const url = referenceLink(journey, target.key, location.href);
    const copied = await copyText(url, navigator.clipboard);
    if (!actions.isConnected || state.selectedId !== journey.id) return;
    feedback.textContent = copied ? "Reference link copied." : "Copying is unavailable. The link is selected for you.";
    const field = actions.querySelector("textarea");
    field.hidden = copied;
    if (!copied) { field.value = url; field.focus(); field.select(); }
  } catch (error) {
    if (!(error instanceof ReferenceLinkError)) throw error;
    console.warn("The source-reference link could not be copied:", error.message);
    if (actions.isConnected) feedback.textContent = error.message;
  }
}

function focusPlace(index, remember = true) {
  const journey = store.byId.get(state.selectedId);
  if (!Number.isInteger(index) || !journey?.waypoints[index]) {
    console.warn("The selected place is not in this account.");
    return;
  }
  if (remember) resetReferenceState();
  state.activePlaceIndex = index;
  refreshReferenceControls();
  atlas.render("explore", atlasCtx());
  updateBoundaryNotice();
  if (remember && journey.detailState === "ready") void rememberReference(journey, index);
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

function scrollProfileTo(section, focusTarget = section, animate = motionEnabled()) {
  const panel = document.querySelector(".panel");
  if (!section || !panel?.contains(section)) {
    console.warn("This section is not available in the selected account.");
    return;
  }
  const toolbar = panel.querySelector(".profile-toolbar");
  panel.scrollTo({
    top: section.getBoundingClientRect().top - panel.getBoundingClientRect().top +
      panel.scrollTop - toolbar.offsetHeight - 12,
    behavior: animate ? "smooth" : "auto",
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
  syncCollectionAddress();
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
  const hint = document.querySelector("[data-explore-hint]");
  if (hint) hint.textContent = total ? "Choose an account or a place marker to explore its source references."
    : "No accounts match these filters. Reset the filters or try a different spelling.";
  wireRail();
}

function wireRail() {
  const list = document.querySelector("[data-rail-list]");
  if (!list) return;
  const activate = (card) => {
    for (const entry of list.querySelectorAll(".rail-entry")) {
      const active = entry.querySelector(".rail-card") === card;
      entry.querySelectorAll("button").forEach((button) => { button.tabIndex = active ? 0 : -1; });
    }
  };
  activate(list.querySelector(".rail-card.sel") || list.querySelector(".rail-card"));
  list.onfocusin = (event) => {
    const entry = event.target.closest(".rail-entry");
    if (entry) activate(entry.querySelector(".rail-card"));
  };
  list.onkeydown = (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) || event.ctrlKey || event.altKey || event.metaKey) return;
    const entry = event.target.closest(".rail-entry");
    if (!entry) return;
    const cards = [...list.querySelectorAll(".rail-card")];
    const index = cards.indexOf(entry.querySelector(".rail-card"));
    const next = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1
      : Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowDown" ? 1 : -1)));
    event.preventDefault();
    activate(cards[next]);
    cards[next].focus({ preventScroll: true });
    cards[next].scrollIntoView({ block: "nearest" });
  };
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
  refreshOpenFlagBrowser();
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

function keepHistoryFocusVisible() {
  const body = document.querySelector("[data-pattern-events]");
  const focused = document.activeElement;
  if (!body?.contains(focused) || focused === body || !body.getClientRects().length) return;
  const viewport = body.getBoundingClientRect();
  const target = focused.getBoundingClientRect();
  const height = Math.min(target.height, body.clientHeight - 24);
  if (target.top < viewport.top + 12) body.scrollTop += target.top - viewport.top - 12;
  else if (target.top + height > viewport.bottom - 12) body.scrollTop += target.top + height - viewport.bottom + 12;
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
    host.querySelectorAll("img:not([data-flag-image])").forEach((image) => {
      image.addEventListener("error", () => image.remove(), { once: true });
    });
    wireImages(host);
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
  updateDocumentTitle();
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
    state.patternEventKey = null;
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
  if (state.patternEventKey && state.historyTestimony && state.patternsLayer === "journeys") {
    params.set("event", state.patternEventKey);
  }
  for (const [key, field] of Object.entries({
    flags: "historyFlags", labels: "historyLabels", routes: "historyRoutes", testimony: "historyTestimony",
  })) if (!state[field]) params.set(key, "0");
  if (state.historyCompare) params.set("compare", "1");
  if (state.historyOpacity !== 1) params.set("opacity", state.historyOpacity);
  if (state.historySplit !== 50) params.set("split", state.historySplit);
  if (state.historySpeed !== 1) params.set("speed", state.historySpeed);
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

function syncHistoryAddress(includeCamera = false) {
  if (state.view === "patterns") {
    history.replaceState(null, "", historyHash(includeCamera));
    updateDocumentTitle();
  }
}

function updateDocumentTitle() {
  let label = "";
  if (state.view === "explore") {
    label = store.byId.get(state.selectedId)?.name ||
      (state.query.trim() ? `Search: ${state.query.trim()}` : state.sharedIds ? "Shared reading list" : state.savedOnly ? "Saved accounts"
        : state.captionedOnly ? "Accounts with captioned chapters" : state.originCountry
        ? `Routes starting in ${state.originCountry}` : state.groupFilter.size === 1
          ? [...state.groupFilter][0] : "The collection");
  } else if (state.view === "patterns") {
    const event = eventsForYear().find((entry) => entry.key === state.patternEventKey);
    label = state.patternsLayer === "origins" ? "Route origins"
      : `${event?.place || state.historyInfo?.name || state.historyPlace || "Historical atlas"}, ${state.scrubYear}`;
  } else if (state.view === "about") label = "About the map";
  else if (state.view === "not-found") label = state.missingKind === "account" ? "Account not found" : "Link not found";
  document.title = `${label ? `${label} | ` : ""}Journeys | Crestwood Oral History Project`;
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
  }, 1200 / state.historySpeed);
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
  const copied = await copyText(address, navigator.clipboard);
  if (!status.isConnected) return;
  if (copied) {
    fallback.hidden = true;
    status.textContent = "The map link has been copied.";
  } else {
    fallback.hidden = false;
    fallback.select();
    status.textContent = "Clipboard access was blocked. You can copy this link.";
  }
}

function toggleAccountReference(open) {
  const reference = document.getElementById("account-reference");
  if (!reference) {
    console.warn("Reference tools are not available without a selected account.");
    return;
  }
  const show = open ?? reference.hidden;
  reference.hidden = !show;
  const trigger = document.querySelector("[data-act='toggle-account-reference']");
  trigger.setAttribute("aria-expanded", String(show));
  if (show) scrollProfileTo(reference, document.getElementById("account-link"));
  else scrollProfileTo(trigger.closest(".account-tool-row"), trigger, false);
}

async function copyAccountReference(kind) {
  const field = document.getElementById(kind === "citation" ? "account-citation" : "account-link");
  const status = document.querySelector("[data-account-copy-status]");
  const label = kind === "citation" ? "citation" : "account link";
  status.textContent = `Copying the ${label}.`;
  const copied = await copyText(field.value, navigator.clipboard);
  if (!status.isConnected) return;
  status.textContent = copied ? `The ${label} has been copied.` : `Clipboard access is unavailable. Select and copy the ${label} below.`;
  if (!copied) {
    field.focus();
    field.select();
    status.textContent = `Clipboard access is unavailable. The ${label} is selected for you to copy.`;
  }
}

function downloadReviewSource() {
  const journey = store.byId.get(state.selectedId);
  if (journey?.detailState !== "ready") {
    console.warn("Load the account details before downloading its review source.");
    return;
  }
  const sourcePackage = {
    type: "FeatureCollection",
    metadata: {
      source: "Crestwood Oral History Project",
      content_revision: store.meta.content_revision,
      exported_at: new Date().toISOString(),
      notice: "Source material for human review. Downloading this file does not approve or verify a claim.",
    },
    features: [{ type: "Feature", geometry: null, properties: journey.sourceProperties }],
  };
  downloadFile(new Blob([JSON.stringify(sourcePackage, null, 2)], { type: "application/json" }), `${journey.id}-review-source.json`);
}

function downloadFile(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
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
  window.addEventListener("beforeprint", preparePrintSheet);
  window.addEventListener("afterprint", finishPrinting);
  window.addEventListener("storage", (event) => {
    if (event.key !== SAVED_ACCOUNTS_KEY && event.key !== null) return;
    loadSavedList();
    if (state.view === "explore") {
      const focused = document.activeElement;
      const savedId = focused.dataset.saveId;
      const accountId = focused.dataset.survivor;
      if (state.savedOnly) { refreshCollection(); refreshOpenPlaceBrowser(); }
      else refreshResearchTools();
      const target = savedId ? document.querySelector(`[data-save-id="${CSS.escape(savedId)}"]`)
        : accountId ? document.querySelector(`[data-survivor="${CSS.escape(accountId)}"]`) : null;
      if (savedId || accountId) (target || document.querySelector(".saved-view"))?.focus({ preventScroll: true });
    }
  });
  onMotionPreferenceChange((reduced) => {
    motion.syncPreference();
    atlas.syncMotion();
    if (reduced) stopHistoryPlayback();
  });
  document.getElementById("topbar").addEventListener("click", onActivate);
  document.querySelector(".skip-link").addEventListener("click", (event) => {
    event.preventDefault();
    focusMainContent();
  });
  document.querySelector(".skip-map").addEventListener("click", (event) => {
    event.preventDefault();
    focusMap();
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
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopHistoryPlayback();
    atlas.syncMotion();
  });
  document.addEventListener("toggle", (event) => {
    if (event.target.matches("[data-history-place-list]")) state.historyPlacesOpen = event.target.open;
  }, true);
  document.addEventListener("keydown", (e) => {
    if (state.view === "explore" && e.target.id === "search" &&
        ["Enter", "ArrowDown"].includes(e.key) && !e.isComposing &&
        !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
      e.preventDefault();
      document.querySelector(".collection-filters").open = false;
      if (MOBILE.matches && !state.selectedId) setExplorePresentation("reader");
      const result = document.querySelector(".rail-card");
      if (result) restoreCollectionFocus(result.dataset.survivor);
      else {
        const empty = document.querySelector(".rail-empty");
        if (!empty) { console.warn("The collection results have not rendered."); return; }
        empty.focus({ preventScroll: true });
        empty.scrollIntoView({ block: "nearest" });
      }
      return;
    }
    if (e.key === "Escape") {
      if (document.querySelector(".research-dialog[open]")) return;
      const settings = document.querySelector(".history-settings[open]");
      const legend = document.querySelector(".map-legend[open]");
      if (state.view === "patterns" && state.historyMatches.length) {
        state.historyMatches = [];
        state.historySearchMessage = "Location suggestions closed.";
        refreshHistorySearch();
        document.querySelector("[data-country-search]").focus();
      } else if (settings) {
        settings.open = false;
        settings.querySelector("summary").focus();
      } else if (legend) {
        legend.open = false;
        legend.querySelector("summary").focus();
      } else if (document.querySelector(".share-feedback:not([hidden])")) {
        closeShare();
      } else if (state.view === "patterns" && SHORT_VIEWPORT.matches && document.querySelector("[data-history-context]")?.open) {
        const context = document.querySelector("[data-history-context]");
        context.open = false;
        context.querySelector("summary").focus();
      } else if (state.historyPlaying) stopHistoryPlayback();
      else if (state.view === "patterns" && state.historyCountry) selectCountry(null, { openContext: false });
      else if (state.view === "about") go("explore");
      else if (state.view === "explore" && document.querySelector("[data-player]:not([hidden])")) closeVideo();
      else if (state.view === "explore" && document.querySelector("#account-reference:not([hidden])")) toggleAccountReference(false);
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
  wireRail();
  wireImages(host);
  const range = host.querySelector("[data-scrub]");
  if (range) range.addEventListener("input", () => setScrub(parseInt(range.value, 10)));
  const yearForm = host.querySelector("[data-year-form]");
  if (yearForm) {
    const year = yearForm.querySelector("input");
    const submitYear = () => {
      stopHistoryPlayback();
      year.setCustomValidity("");
      const value = year.valueAsNumber;
      if (!Number.isInteger(value)) {
        year.setCustomValidity(`Enter a whole year from ${store.time.min} to ${store.time.max}.`);
        year.reportValidity();
        return;
      }
      const bounded = Math.max(store.time.min, Math.min(store.time.max, value));
      setScrub(bounded);
      document.querySelector("[data-year-status]").textContent = value === bounded ? ""
        : `The atlas covers ${store.time.min} to ${store.time.max}. Showing ${bounded}.`;
    };
    year.addEventListener("input", () => year.setCustomValidity(""));
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
  host.querySelector("[data-history-speed]")?.addEventListener("change", (event) => {
    const speed = Number(event.target.value);
    if (![1, 2, 4].includes(speed)) {
      console.warn("The timeline speed is not supported.");
      return;
    }
    const playing = state.historyPlaying;
    stopHistoryPlayback();
    state.historySpeed = speed;
    if (playing) toggleHistoryPlayback();
    syncHistoryAddress();
  });
  const search = host.querySelector("#search");
  if (search) {
    search.addEventListener("input", () => onSearch(search.value));
  }
  host.querySelector(".collection-filters")?.addEventListener("toggle", () => atlas.resize());
  host.querySelectorAll("[data-group]").forEach((input) => {
    input.addEventListener("change", () => toggleGroup(input.dataset.group, input.checked));
  });
  host.querySelector("[data-caption-filter]")?.addEventListener("change", event => {
    state.captionedOnly = event.target.checked;
    state.railLimit = RAIL_PAGE;
    refreshCollection();
  });
}
function wireImages(host) {
  host.querySelectorAll("[data-flag-image]").forEach(image => {
    image.addEventListener("error", () => {
      image.hidden = true;
      image.nextElementSibling.hidden = false;
      console.warn("A flag image could not load; its source and dates remain available.");
    }, { once: true });
  });
  host.querySelectorAll(".medal img").forEach((image) => {
    image.addEventListener("error", () => image.remove(), { once: true });
  });
  host.querySelectorAll(".profile-photo img").forEach((image) => {
    image.addEventListener("error", () => {
      image.parentElement.textContent = "This photograph could not load. Open the source image.";
      console.warn("An OHP gallery photograph could not load.");
    }, { once: true });
  });
}
function onActivate(e) {
  const t = e.target.closest("[data-act],[data-view],[data-survivor],[data-layer],[data-event],[data-place-step],[data-video],[data-profile-section],[data-origin],[data-history-match],[data-save-id],[data-copy-account],[data-search-suggestion],[data-browse-place],[data-copy-reference],[data-related-account],[data-flag-controller]");
  if (!t || !e.currentTarget.contains(t)) return;
  if (t.dataset.view) return go(t.dataset.view);
  if (t.dataset.layer) return setLayer(t.dataset.layer);
  if (t.dataset.survivor != null) return selectSurvivor(t.dataset.survivor);
  if (t.dataset.saveId) return toggleSavedAccount(t.dataset.saveId);
  if (t.dataset.copyAccount) return copyAccountReference(t.dataset.copyAccount);
  if (t.dataset.copyReference != null) return copyReference(Number(t.dataset.copyReference));
  if (t.dataset.relatedAccount) {
    if (!collectionResults(store, state).some(journey => journey.id === t.dataset.relatedAccount)) {
      console.warn("This related account is no longer in the current results.");
      refreshResearchTools("The results changed. Choose an available account.");
      return;
    }
    return selectSurvivor(t.dataset.relatedAccount, true);
  }
  if (t.dataset.browsePlace) {
    document.getElementById("place-browser").close();
    return filterPlace(t.dataset.browsePlace);
  }
  if (t.dataset.flagController) {
    const dialog = document.getElementById("flag-browser");
    const year = Number(t.dataset.flagYear);
    if (!Number.isInteger(year) || year < store.time.min || year > store.time.max || !atlas.countryInfo(t.dataset.flagController, year)) {
      dialog.querySelector("[data-flag-count]").textContent = "This administration outline is not available at that date. Choose another year.";
      console.warn("The selected flag's map outline is not available for this year.");
      return;
    }
    dialog.remove();
    dialog.close();
    if (year !== state.scrubYear) setScrub(year);
    return selectCountry(t.dataset.flagController);
  }
  if (t.dataset.searchSuggestion) {
    onSearch(t.dataset.searchSuggestion);
    return document.getElementById("search").focus({ preventScroll: true });
  }
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
    case "clear-place-filter":
      state.placeFilter = null;
      refreshCollection();
      return document.getElementById("search").focus({ preventScroll: true });
    case "focus-map": return focusMap();
    case "focus-reader": return document.getElementById("profile-name")?.focus({ preventScroll: true });
    case "retry-profile": return loadSelectedProfile(state.selectedId, true);
    case "reload-collection": return location.reload();
    case "download-review": return downloadReviewSource();
    case "toggle-saved-view": return toggleSavedView();
    case "browse-places": return openPlaceBrowser();
    case "browse-flags": return openFlagBrowser();
    case "close-research-dialog": return t.closest("dialog").close();
    case "share-reading-list": return shareReadingList();
    case "copy-reading-list": return copyReadingList();
    case "download-list-sources": return downloadListSources();
    case "download-shared-sources": return downloadListSources(true);
    case "print-account": return printAccount();
    case "read-full-biography": return openBiography();
    case "retry-biography": {
      const dialog = document.getElementById("biography-dialog");
      return fillBiographyDialog(dialog, store.byId.get(dialog.dataset.survivorId));
    }
    case "print-reading-list": return printReadingList();
    case "save-shared-list": return saveSharedList();
    case "leave-shared-list": return leaveSharedList();
    case "reset-saved-list": return resetSavedList();
    case "toggle-account-reference": return toggleAccountReference();
    case "close-account-reference": return toggleAccountReference(false);
    case "previous-account": return navigateAccount(-1);
    case "next-account": return navigateAccount(1);
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
      resetReferenceState();
      state.pendingHistoryCamera = null;
      document.querySelectorAll("[data-place-step]").forEach((button) => button.setAttribute("aria-pressed", "false"));
      atlas.render(state.view, atlasCtx());
      updateBoundaryNotice();
      refreshReferenceControls();
      syncCollectionAddress();
      return atlas.resetCamera();
    case "clear-reference":
      resetReferenceState();
      refreshReferenceControls();
      syncCollectionAddress();
      atlas.render("explore", atlasCtx());
      return scrollProfileTo(document.getElementById("profile-places"));
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
function pathProfileId() {
  return /^\/survivor\/([a-z0-9_-]+)\/?$/.exec(location.pathname)?.[1] || null;
}
function currentFragment() {
  if (location.hash) return location.hash;
  const id = pathProfileId();
  return id ? `#/survivor/${id}${location.search}` : "";
}
function setHash(h) {
  if (pathProfileId()) {
    const fragment = currentFragment();
    const query = new URLSearchParams(location.search);
    query.delete("ref");
    history.replaceState(history.state, "", `/${query.size ? `?${query}` : ""}${fragment}`);
  }
  programmatic = true;
  if (location.hash !== h) location.hash = h;
  else programmatic = false;
}
function showMissing(kind) {
  state.missingKind = kind;
  state.view = "not-found";
  render();
  focusMainContent();
}

function route() {
  if (programmatic) { programmatic = false; return; }
  stopHistoryPlayback();
  resetReferenceState();
  const fragment = currentFragment();
  const separator = fragment.indexOf("?");
  const hash = separator < 0 ? fragment : fragment.slice(0, separator);
  const query = separator < 0 ? "" : fragment.slice(separator + 1);
  const params = new URLSearchParams(query);
  const [, kind, value] = hash.split("/");
  if (params.has("ref") && kind !== "survivor") return showMissing("place");
  if (kind === "guided" || hash === "#map" || hash === "#overlay") {
    if (!restoreCollectionAddress(params)) return showMissing("filter");
    history.replaceState(null, "", exploreHash());
    state.view = "explore";
    state.selectedId = null;
    state.activePlaceIndex = null;
    state.explorePresentation = "auto";
    render();
    return;
  }
  if (kind === "survivor" && value && store.byId.has(value)) {
    if (!restoreCollectionAddress(params)) return showMissing("filter");
    state.selectedId = store.byId.get(value).id;
    state.activePlaceIndex = null;
    state.explorePresentation = "auto";
    state.view = "explore";
    if (params.has("ref")) {
      state.referenceKey = params.get("ref");
      state.referenceResolving = isReferenceKey(state.referenceKey);
      state.referenceMessage = state.referenceResolving ? "Opening the linked source reference."
        : "This source-reference link is invalid. The account remains available below.";
    }
    if (state.selectedId !== value) history.replaceState(null, "", accountHash(state.selectedId));
    render();
    return;
  }
  if (kind === "survivor") return showMissing("account");
  if (kind === "place" && value) {
    const found = store.journeys.find((j) => j.waypoints.some((w) => slug(w.canonical) === value));
    if (!found) return showMissing("place");
    if (!restoreCollectionAddress(params)) return showMissing("filter");
    state.view = "explore"; state.selectedId = found.id;
    state.activePlaceIndex = null; state.explorePresentation = "auto";
    render(); return;
  }
  if (kind === "place") return showMissing("place");
  if (kind === "patterns" && value && /^\d{4}$/.test(value)) {
    const year = Math.max(store.time.min, Math.min(store.time.max, Number(value)));
    const event = params.has("event") ? store.events.find((entry) => entry.key === params.get("event") && entry.year === year) : null;
    if (params.has("event") && (!event || params.get("layer") === "origins" ||
        params.get("testimony") === "0" || params.get("country"))) return showMissing("place");
    state.scrubYear = year;
    state.patternEventKey = event?.key || null;
    state.historyPlacesOpen = false;
    if (event) state.historyContextOpen = true;
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
    const speed = Number(params.get("speed") || 1);
    if (![1, 2, 4].includes(speed)) return showMissing("page");
    state.historySpeed = speed;
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
    if (event) {
      const title = document.getElementById("testimony-place-title");
      focusHistoryContent(title, title.closest(".testimony-moment"));
    }
    return;
  }
  if (VIEWS.includes(kind)) {
    if (kind === "patterns" && value) return showMissing("page");
    const previous = state.selectedId;
    if (kind === "explore") {
      if (!restoreCollectionAddress(params)) return showMissing("filter");
      state.selectedId = null;
      state.activePlaceIndex = null;
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
