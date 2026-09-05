import { motionEnabled, SYSTEM_REDUCED_MOTION } from "./config.js";

const gsap = window.gsap;
let warned = false;
let mosaicStates = [];
let beltTweens = [];
let landingTimeline = null;
const entranceTweens = new Set();

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
  let tween;
  tween = gsap.from(elements, {
    ...from,
    duration: .45,
    ease: "power3.out",
    clearProps: "opacity,visibility,transform,clipPath",
    ...options,
    onComplete(...args) {
      entranceTweens.delete(tween);
      options.onComplete?.apply(this, args);
    },
    onInterrupt(...args) {
      entranceTweens.delete(tween);
      options.onInterrupt?.apply(this, args);
    },
  });
  entranceTweens.add(tween);
  return tween;
}

export function init() {
  updateMotionMode();
  canAnimate();
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) pauseMosaic();
    else if (document.body.dataset.view === "landing") startMosaic();
  });
}

export function syncPreference() {
  updateMotionMode();
  if (motionEnabled()) {
    if (document.body.dataset.view === "landing" && !document.hidden) startMosaic();
    return;
  }
  if (landingTimeline) {
    landingTimeline.progress(1);
    landingTimeline.kill();
    landingTimeline = null;
  }
  for (const tween of [...entranceTweens]) {
    tween.progress(1);
    tween.kill();
  }
  for (const counter of document.querySelectorAll("[data-counter]")) {
    counter.textContent = Number(counter.dataset.counter).toLocaleString("en-CA");
  }
  pauseMosaic();
}

function updateMotionMode() {
  document.documentElement.dataset.motion = motionEnabled() ? (gsap ? "gsap" : "static") : "reduced";
}

export function animateShell() {
  if (!canAnimate()) return;
  reveal(".brand-title, .nav-plain", { opacity: .4 }, { duration: .35 });
}

export function animateOverlay(view, changes) {
  if (landingTimeline) { landingTimeline.kill(); landingTimeline = null; }
  if (view !== "landing") stopMosaic();
  if (!canAnimate()) {
    document.documentElement.dataset.mosaicMotion = view === "landing" ? "static" : "inactive";
    return;
  }
  const mobile = window.matchMedia("(max-width: 820px)").matches;

  if (view === "landing") {
    const counters = [...document.querySelectorAll("[data-counter]")];
    if (!changes.viewChanged) {
      for (const element of counters) element.textContent = Number(element.dataset.counter).toLocaleString("en-CA");
      return;
    }
    startMosaic();
    if (SYSTEM_REDUCED_MOTION) return;
    for (const element of counters) element.textContent = "0";
    landingTimeline = gsap.timeline({ defaults: { ease: "power3.out" } });
    landingTimeline
      .fromTo(".landing-card > *", {
        autoAlpha: 0,
        y: 10,
      }, {
        autoAlpha: 1,
        y: 0,
        duration: .5,
        stagger: .04,
        clearProps: "opacity,visibility,transform",
      });
    for (const element of counters) {
      const target = Number(element.dataset.counter);
      const state = { value: 0 };
      landingTimeline.to(state, {
        value: target,
        duration: 1.2,
        ease: "power3.out",
        snap: { value: 1 },
        onUpdate: () => {
          element.textContent = Math.round(state.value).toLocaleString("en-CA");
        },
        onComplete: () => {
          element.textContent = target.toLocaleString("en-CA");
        },
      }, .2);
    }
    return;
  }

  if (view === "explore") {
    if (changes.viewChanged) {
      reveal(".rail", mobile ? { opacity: .55, y: 16 } : { opacity: .55, x: -12 });
    }
    if (changes.selectionChanged && document.querySelector(".panel")) {
      reveal(".panel", mobile ? { opacity: 0, y: 16 } : { opacity: 0, x: 16 });
    }
    return;
  }

  if (view === "patterns" && (changes.viewChanged || changes.layerChanged)) {
    reveal(
      ".patterns-intro > h2, .patterns-intro > .kicker, .patterns-intro > .lede, " +
      ".patterns-intro > .legend, .patterns-intro > .cross-note, " +
      ".patterns-intro > .origin-list, .patterns-intro > .cross-sub, " +
      ".patterns-map-head, .history-dossier",
      { opacity: .55, y: 8 },
      { stagger: .035 },
    );
    reveal(".scrubber", { opacity: .55, y: 8 }, { delay: .04 });
    return;
  }

  if (view === "about" && changes.viewChanged) {
    reveal(".about-header > *, .collection-ledger, .about-grid > *, .about-wrap > .cta-row", {
      autoAlpha: 0,
      y: 10,
    }, {
      stagger: .04,
    });
  }
}

export function animatePatternEvent() {
  if (!canAnimate()) return;
  reveal(".testimony-moment", { opacity: .55, x: 8 }, {
    duration: .38,
  });
}

function startMosaic() {
  if (document.hidden || !canAnimate()) {
    pauseMosaic();
    return;
  }
  if (mosaicStates.length) {
    for (const tween of beltTweens) tween.resume();
    for (const state of mosaicStates) state.call?.resume();
    document.documentElement.dataset.mosaicMotion = "animated";
    document.documentElement.dataset.mosaicBelts = "rolling";
    return;
  }
  const tiles = gsap.utils.toArray(".mosaic-tile:not([data-clone])");
  if (!tiles.length) return;
  document.documentElement.dataset.mosaicMotion = "animated";
  beltTweens = gsap.utils.toArray(".mosaic-track").map((track, index) => {
    const duration = [120, 144, 132, 160, 148, 174][index] || 144;
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

function pauseMosaic() {
  for (const state of mosaicStates) state.call?.pause();
  for (const tween of beltTweens) tween.pause();
  if (gsap) {
    for (const tween of gsap.getTweensOf(".mosaic-side")) {
      tween.progress(1);
      tween.kill();
    }
  }
  document.documentElement.dataset.mosaicMotion = document.body.dataset.view === "landing" ? "static" : "inactive";
  document.documentElement.dataset.mosaicBelts = "still";
}

function stopMosaic() {
  pauseMosaic();
  for (const state of mosaicStates) if (state.call) state.call.kill();
  for (const tween of beltTweens) tween.kill();
  mosaicStates = [];
  beltTweens = [];
  if (gsap) gsap.killTweensOf(".mosaic-side");
  document.documentElement.dataset.mosaicMotion = document.body.dataset.view === "landing"
    ? "static"
    : "inactive";
  document.documentElement.dataset.mosaicBelts = "still";
}

function scheduleTile(state, initial = false) {
  if (!state || state.people.length < 2) return;
  const seconds = initial
    ? 2.6 + (state.tileIndex % 12) * .22
    : 8 + ((state.tileIndex + state.index * 3) % 9) * .7;
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
      duration: .75,
      ease: "power2.inOut",
    });
    gsap.fromTo(incoming, {
      autoAlpha: 0,
    }, {
      autoAlpha: 1,
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
