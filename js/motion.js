import { REDUCED_MOTION } from "./config.js";

const gsap = window.gsap;
let warned = false;
let mosaicTiles = [];
const mosaicState = new WeakMap();

function canAnimate() {
  if (REDUCED_MOTION) return false;
  if (gsap) return true;
  if (!warned) {
    console.warn("GSAP did not load; interface motion is disabled.");
    warned = true;
  }
  return false;
}

function reveal(targets, from, options = {}) {
  const elements = gsap.utils.toArray(targets);
  if (!elements.length) return null;
  gsap.killTweensOf(elements);
  return gsap.fromTo(elements, from, {
    duration: .62,
    ease: "power3.out",
    clearProps: "opacity,visibility,transform,clipPath",
    ...options,
  });
}

export function init() {
  document.documentElement.dataset.motion = REDUCED_MOTION ? "reduced" : gsap ? "gsap" : "static";
  canAnimate();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMosaic();
    else if (document.querySelector(".portrait-mosaic[data-mosaic]")) startMosaic();
  });
}

export function animateShell() {
  if (!canAnimate()) return;
  reveal(".brand-title, .nav-plain", { opacity: .4 }, { duration: .35 });
}

export function animateOverlay(view, changes) {
  if (!canAnimate()) {
    document.documentElement.dataset.mosaicMotion = view === "landing" ? "static" : "inactive";
    return;
  }
  const mobile = window.matchMedia("(max-width: 820px)").matches;

  if (view === "landing" && changes.viewChanged) {
    startMosaic();
    const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    timeline
      .fromTo(".landing-card > *", {
        autoAlpha: 0,
        y: 14,
      }, {
        autoAlpha: 1,
        y: 0,
        duration: .66,
        stagger: .055,
        clearProps: "opacity,visibility,transform",
      })
      .fromTo(".legend-mini > span", {
        autoAlpha: 0,
        x: 8,
      }, {
        autoAlpha: 1,
        x: 0,
        duration: .45,
        stagger: .06,
        clearProps: "opacity,visibility,transform",
      }, "-=.3");
    return;
  }

  stopMosaic();

  if (view === "guided" && (changes.viewChanged || changes.storyChanged)) {
    reveal(".narr", mobile ? { autoAlpha: 0, y: 24 } : { autoAlpha: 0, x: -24 });
    reveal(".narr-head > *", { autoAlpha: 0, y: 10 }, { delay: .08, stagger: .045 });
    reveal(".chapter.is-active > *", { autoAlpha: 0, y: 10 }, { delay: .18, stagger: .04 });
    return;
  }

  if (view === "explore") {
    if (changes.viewChanged) {
      reveal(".rail", mobile ? { autoAlpha: 0, y: 24 } : { autoAlpha: 0, x: -20 });
    }
    if (changes.selectionChanged && document.querySelector(".panel")) {
      reveal(".panel", mobile ? { autoAlpha: 0, y: 28 } : { autoAlpha: 0, x: 24 });
    }
    return;
  }

  if (view === "patterns" && (changes.viewChanged || changes.layerChanged)) {
    reveal(
      ".patterns-intro > h2, .patterns-intro > .kicker, .patterns-intro > .lede, " +
      ".patterns-intro > .legend, .patterns-intro > .cross-note, " +
      ".patterns-intro > .origin-list, .patterns-intro > .cross-sub",
      { autoAlpha: 0, y: 8 },
      { stagger: .035 },
    );
    reveal(".scrubber", { autoAlpha: 0, y: 16 }, { delay: .08 });
    return;
  }

  if (view === "about" && changes.viewChanged) {
    reveal(".about-wrap > h1, .about-wrap > .kicker, .about-wrap > .lede, .about-grid > *, .about-wrap > .cta-row", {
      autoAlpha: 0,
      y: 16,
    }, {
      stagger: .055,
    });
  }
}

export function animateChapter(section) {
  if (!canAnimate() || !section) return;
  reveal(section.querySelectorAll(".ch-head, .ch-title, .ch-sub, blockquote"), {
    opacity: .25,
    y: 10,
  }, {
    duration: .45,
    stagger: .045,
  });
}

function startMosaic() {
  stopMosaic();
  if (!canAnimate()) {
    document.documentElement.dataset.mosaicMotion = "static";
    return;
  }
  const tiles = gsap.utils.toArray(".mosaic-tile");
  if (!tiles.length) return;
  document.documentElement.dataset.mosaicMotion = "animated";
  mosaicTiles = tiles;
  tiles.forEach((tile, index) => {
    let people = [];
    try {
      people = JSON.parse(tile.dataset.people || "[]");
    } catch (error) {
      console.error("Invalid mosaic data", error);
    }
    mosaicState.set(tile, { people, index: 0, front: true, call: null });
    scheduleTile(tile, index, true);
  });
}

function stopMosaic() {
  for (const tile of mosaicTiles) {
    const state = mosaicState.get(tile);
    if (state?.call) state.call.kill();
  }
  mosaicTiles = [];
  if (gsap) gsap.killTweensOf(".mosaic-side");
  document.documentElement.dataset.mosaicMotion = document.querySelector(".portrait-mosaic[data-mosaic]")
    ? "static"
    : "inactive";
}

function scheduleTile(tile, tileIndex, initial = false) {
  const state = mosaicState.get(tile);
  if (!state || state.people.length < 2) return;
  const seconds = initial
    ? 2.6 + (tileIndex % 12) * .22
    : 4.8 + ((tileIndex + state.index * 3) % 9) * .4;
  tile.dataset.cycleSeconds = seconds.toFixed(2);
  state.call = gsap.delayedCall(seconds, () => {
    if (document.hidden || !document.querySelector(".portrait-mosaic[data-mosaic]")) {
      stopMosaic();
      return;
    }
    swapTile(tile);
    scheduleTile(tile, tileIndex);
  });
}

function swapTile(tile) {
  if (document.hidden || !document.querySelector(".portrait-mosaic[data-mosaic]")) {
    stopMosaic();
    return;
  }
  const state = mosaicState.get(tile);
  if (!state || state.people.length < 2) return;
  state.index = (state.index + 1) % state.people.length;
  const visible = tile.querySelector(state.front ? ".is-front" : ".is-back");
  const incoming = tile.querySelector(state.front ? ".is-back" : ".is-front");
  setMosaicPerson(incoming, state.people[state.index]);
  gsap.to(visible, {
    autoAlpha: 0,
    scale: .97,
    duration: .75,
    ease: "power2.inOut",
  });
  gsap.fromTo(incoming, {
    autoAlpha: 0,
    scale: 1.025,
  }, {
    autoAlpha: 1,
    scale: 1,
    duration: .9,
    ease: "power2.inOut",
  });
  state.front = !state.front;
  tile.dataset.swapCount = String((Number(tile.dataset.swapCount) || 0) + 1);
}

function setMosaicPerson(side, person) {
  let image = side.querySelector("img");
  const initials = side.querySelector(".mosaic-initials");
  const name = side.querySelector(".mosaic-name");
  initials.textContent = person.i || "";
  name.textContent = person.n || "";
  if (person.p) {
    if (!image) {
      image = document.createElement("img");
      image.alt = "";
      image.loading = "lazy";
      image.decoding = "async";
      side.prepend(image);
    }
    image.src = person.p;
    initials.hidden = true;
    image.onerror = () => {
      image.remove();
      initials.hidden = false;
    };
  } else {
    if (image) image.remove();
    initials.hidden = false;
  }
}
