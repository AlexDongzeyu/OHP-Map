import { REDUCED_MOTION } from "./config.js";

const gsap = window.gsap;
let warned = false;

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
}

export function animateShell() {
  if (!canAnimate()) return;
  reveal(".brand-title, .nav-plain", { opacity: .4 }, { duration: .35 });
}

export function animateOverlay(view, changes) {
  if (!canAnimate()) return;
  const mobile = window.matchMedia("(max-width: 820px)").matches;

  if (view === "landing" && changes.viewChanged) {
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
