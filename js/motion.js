import { motionEnabled, SYSTEM_REDUCED_MOTION } from "./config.js";

const gsap = window.gsap;
let warned = false;
let mosaicStates = [];
let beltTweens = [];

function canAnimate() {
  if (!motionEnabled()) return false;
  if (gsap) return true;
  if (!warned) {
    console.warn("GSAP did not load; interface motion is disabled.");
    warned = true;
  }
  return false;
}

function reveal(targets, from, options = {}) {
  if (SYSTEM_REDUCED_MOTION) return null;
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
  updateMotionMode();
  canAnimate();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopMosaic();
    else if (document.body.dataset.view === "landing") startMosaic();
  });
}

function updateMotionMode() {
  document.documentElement.dataset.motion = motionEnabled() ? (gsap ? "gsap" : "static") : "reduced";
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
    if (SYSTEM_REDUCED_MOTION) return;
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

export function animatePatternEvent() {
  if (!canAnimate()) return;
  reveal(".event-card, .event-empty", { autoAlpha: 0, x: -8 }, {
    duration: .38,
    stagger: .025,
  });
}

function startMosaic() {
  stopMosaic();
  if (!canAnimate()) {
    document.documentElement.dataset.mosaicMotion = "static";
    return;
  }
  const tiles = gsap.utils.toArray(".mosaic-tile:not([data-clone])");
  if (!tiles.length) return;
  document.documentElement.dataset.mosaicMotion = "animated";
  beltTweens = gsap.utils.toArray(".mosaic-track").map((track, index) => {
    const duration = ([76, 92, 82, 98, 86, 104][index] || 90) *
      (SYSTEM_REDUCED_MOTION ? 1.15 : 1);
    return index % 2
      ? gsap.fromTo(track, { xPercent: -50 }, { xPercent: 0, duration, ease: "none", repeat: -1 })
      : gsap.to(track, { xPercent: -50, duration, ease: "none", repeat: -1 });
  });
  document.documentElement.dataset.mosaicBelts = "rolling";
  tiles.forEach((tile, index) => {
    let people = [];
    try {
      people = JSON.parse(tile.dataset.people || "[]");
    } catch (error) {
      console.error("Invalid mosaic data", error);
    }
    const elements = gsap.utils.toArray(`.mosaic-tile[data-tile-id="${tile.dataset.tileId}"]`);
    const state = { elements, people, index: 0, front: true, call: null, tileIndex: index };
    mosaicStates.push(state);
    scheduleTile(state, true);
  });
}

function stopMosaic() {
  for (const state of mosaicStates) if (state.call) state.call.kill();
  for (const tween of beltTweens) tween.kill();
  mosaicStates = [];
  beltTweens = [];
  if (gsap) gsap.killTweensOf(".mosaic-side");
  document.documentElement.dataset.mosaicMotion = document.body.dataset.view === "landing"
    ? "static"
    : "inactive";
}

function scheduleTile(state, initial = false) {
  if (!state || state.people.length < 2) return;
  const seconds = initial
    ? 2.6 + (state.tileIndex % 12) * .22
    : (4.8 + ((state.tileIndex + state.index * 3) % 9) * .4) *
      (SYSTEM_REDUCED_MOTION ? 1.08 : 1);
  for (const tile of state.elements) tile.dataset.cycleSeconds = seconds.toFixed(2);
  state.call = gsap.delayedCall(seconds, () => {
    if (document.hidden || document.body.dataset.view !== "landing") {
      stopMosaic();
      return;
    }
    swapTile(state);
    scheduleTile(state);
  });
}

function swapTile(state) {
  if (document.hidden || document.body.dataset.view !== "landing") {
    stopMosaic();
    return;
  }
  if (!state || state.people.length < 2) return;
  state.index = (state.index + 1) % state.people.length;
  for (const tile of state.elements) {
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
    tile.dataset.swapCount = String((Number(tile.dataset.swapCount) || 0) + 1);
  }
  state.front = !state.front;
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
