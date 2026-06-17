// APP — the landing flow + the three modes, mode switcher, deep links, scrubber.
// A first-time visitor lands on the intro (doc 11). Choosing "Follow one journey" or
// "Explore the map" reveals the app shell. One Leaflet map; each mode owns its layers.
import { loadData } from "./data.js";
import { createMap } from "./mapcore.js";
import { createExplore } from "./explore.js";
import { createGuided } from "./guided.js";
import { createPatterns } from "./patterns.js";
import { createScrubber } from "./scrubber.js";
import { drawHero } from "./hero.js";
import { REDUCED_MOTION } from "./config.js";

const MODES = ["guided", "explore", "patterns"];
const SCRUBBER_MODES = new Set(["explore", "patterns"]);

async function main() {
  const statusEl = document.getElementById("status");
  const intro = document.getElementById("intro");

  let store;
  try {
    store = await loadData();
  } catch (err) {
    statusEl.hidden = false;
    statusEl.textContent =
      "We couldn't load the journeys right now. Please refresh in a moment.";
    console.error(err);
    return;
  }

  // ---- intro content: scale line + dignified data-drawn hero --------------------
  const places = store.places ? store.places.size : 0;
  const tmin = (store.meta && store.meta.time_min) || 1933;
  const tmax = (store.meta && store.meta.time_max) || 1950;
  const scaleEl = document.getElementById("scale");
  if (scaleEl)
    scaleEl.textContent =
      `${store.survivors.length} survivors · ${places} places · ${tmin}–${tmax}`;
  drawHero(document.getElementById("hero-canvas"), store);

  document.getElementById("survivor-count").textContent = store.survivors.length;
  setupBanner(store);

  const map = createMap("map");
  const panel = document.getElementById("panel");
  const scrubberEl = document.getElementById("scrubber");

  let programmaticHash = false;
  const setHash = (h) => {
    programmaticHash = true;
    if (location.hash !== h) location.hash = h;
    else programmaticHash = false;
  };

  const ctx = { map, store, panel, scrubberEl, setHash };
  const scrubber = createScrubber(ctx);
  const modes = {
    guided: createGuided(ctx),
    explore: createExplore(ctx),
    patterns: createPatterns(ctx),
  };

  let current = null;
  let entered = false;

  function revealShell() {
    if (entered) return;
    entered = true;
    document.querySelector(".topbar").hidden = false;
    document.querySelector(".layout").hidden = false;
    intro.classList.add("is-dismissed");
    setTimeout(() => { intro.hidden = true; map.invalidateSize(); },
      REDUCED_MOTION ? 0 : 420);
    setTimeout(() => map.invalidateSize(), 80);
  }

  function showIntro() {
    intro.hidden = false;
    requestAnimationFrame(() => intro.classList.remove("is-dismissed"));
    entered = false;
    current = null;
    document.querySelector(".topbar").hidden = true;
    document.querySelector(".layout").hidden = true;
    const sb = document.getElementById("scrubber");
    if (sb) sb.hidden = true;
    if (location.hash) setHash("");
  }

  function activate(mode) {
    if (current === mode) return;
    if (current) {
      modes[current].deactivate();
      if (SCRUBBER_MODES.has(current)) scrubber.deactivate();
    }
    current = mode;
    modes[mode].activate();
    if (SCRUBBER_MODES.has(mode)) scrubber.activate();
    document.querySelectorAll(".mode-tab[data-mode]").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ---- routing ---------------------------------------------------------------

  function route() {
    const hash = location.hash || "#/guided";
    const [, kind, value] = hash.split("/");
    revealShell();
    if (kind === "survivor" && value) {
      activate("explore");
      modes.explore.selectSurvivor(decodeURIComponent(value), true);
    } else if (kind === "place" && value) {
      activate("explore");
      modes.explore.selectPlace(decodeURIComponent(value), true);
    } else if (MODES.includes(kind)) {
      activate(kind);
    } else {
      activate("guided");
    }
  }

  window.addEventListener("hashchange", () => {
    if (programmaticHash) { programmaticHash = false; return; }
    if (!location.hash || location.hash.length <= 2) return;
    route();
  });

  // Intro primary/secondary actions.
  intro.querySelectorAll("[data-go]").forEach((b) =>
    b.addEventListener("click", () => { setHash(`#/${b.dataset.go}`); route(); })
  );

  // Mode tabs.
  document.querySelectorAll(".mode-tab[data-mode]").forEach((b) =>
    b.addEventListener("click", () => { setHash(`#/${b.dataset.mode}`); route(); })
  );

  // Brand returns to the introduction.
  document.getElementById("brand").addEventListener("click", showIntro);

  setupAbout();

  // ---- start: honour a deep link, else show the intro -------------------------
  const deep = location.hash && location.hash.length > 2;
  if (deep) route();
}

// ---- helpers -----------------------------------------------------------------

function setupBanner(store) {
  const banner = document.getElementById("notice-banner");
  if (store.meta && store.meta.sample_data) {
    banner.innerHTML =
      "Demonstration build — every survivor shown is <strong>fictional, illustrative " +
      "sample data</strong>, not real testimony. See the README.";
    banner.hidden = false;
  } else if (store.meta && store.meta.pending > 0) {
    banner.innerHTML =
      `Journeys are <strong>auto-extracted from public archive summaries</strong> and ` +
      `<strong>pending verification</strong> — approximate pointers into the ` +
      `<a href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">archive</a>, ` +
      `not authoritative. <button class="link-btn" id="banner-about">Why?</button>`;
    banner.hidden = false;
    const b = document.getElementById("banner-about");
    if (b) b.addEventListener("click", () => openAbout());
  }
}

function openAbout() {
  const m = document.getElementById("about");
  m.hidden = false;
  requestAnimationFrame(() => m.classList.add("is-open"));
  document.getElementById("about-close").focus();
}
function closeAbout() {
  const m = document.getElementById("about");
  m.classList.remove("is-open");
  setTimeout(() => { m.hidden = true; }, 250);
}
function setupAbout() {
  document.getElementById("about-tab").addEventListener("click", openAbout);
  document.getElementById("open-about").addEventListener("click", openAbout);
  document.getElementById("about-close").addEventListener("click", closeAbout);
  document.getElementById("about").addEventListener("click", (e) => {
    if (e.target.id === "about") closeAbout();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("about").hidden) closeAbout();
  });
}

main();
