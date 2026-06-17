// APP — wires the three modes, the mode switcher, deep links, and the scrubber.
// One Leaflet map; each mode adds/removes its own layers on activation so the views
// never fight each other.
import { loadData } from "./data.js";
import { createMap } from "./mapcore.js";
import { createExplore } from "./explore.js";
import { createGuided } from "./guided.js";
import { createPatterns } from "./patterns.js";
import { createScrubber } from "./scrubber.js";

const MODES = ["guided", "explore", "patterns"];
const SCRUBBER_MODES = new Set(["explore", "patterns"]);

async function main() {
  const statusEl = document.getElementById("status");
  let store;
  try {
    store = await loadData();
  } catch (err) {
    statusEl.hidden = false;
    statusEl.textContent =
      "Could not load the map data. Run `python -m pipeline.build` first, then reload.";
    console.error(err);
    return;
  }

  document.getElementById("survivor-count").textContent = store.survivors.length;
  if (store.meta && store.meta.sample_data) {
    document.getElementById("sample-banner").hidden = false;
  }

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
  function activate(mode) {
    if (current === mode) return;
    if (current) {
      modes[current].deactivate();
      if (SCRUBBER_MODES.has(current)) scrubber.deactivate();
    }
    current = mode;
    modes[mode].activate();
    if (SCRUBBER_MODES.has(mode)) scrubber.activate();
    document.querySelectorAll(".mode-tab").forEach((b) => {
      const on = b.dataset.mode === mode;
      b.classList.toggle("is-active", on);
      b.setAttribute("aria-selected", on ? "true" : "false");
    });
    // Invalidate size after layout changes so tiles fill the container.
    setTimeout(() => map.invalidateSize(), 50);
  }

  // ---- routing ---------------------------------------------------------------

  function route() {
    const hash = location.hash || "#/guided";
    const [, kind, value] = hash.split("/");
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
    route();
  });

  document.querySelectorAll(".mode-tab").forEach((b) =>
    b.addEventListener("click", () => setHash(`#/${b.dataset.mode}`) || route())
  );

  route(); // initial
}

main();
