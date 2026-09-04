// Headless smoke test for the world-atlas front end (globe landing, free zoom, search,
// group filters, density). Fails on any console error or uncaught exception.
const puppeteer = require("puppeteer-core");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:8124";

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 850 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  await page.setRequestInterception(true);
  let delayInitialDataset = true;
  page.on("request", (request) => {
    if (delayInitialDataset && /\/data\/survivors\.geojson/.test(request.url())) {
      delayInitialDataset = false;
      setTimeout(() => request.continue(), 800);
      return;
    }
    request.continue();
  });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => { if (!/favicon/.test(r.url())) errors.push("requestfailed: " + r.url()); });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await check("loading veil matches the atlas", async () => {
    await page.waitForSelector("#loading:not([hidden])", { timeout: 3000 });
    const loading = await page.evaluate(() => {
      const cover = document.querySelector("#loading");
      return {
        title: cover.querySelector(".loading-title")?.textContent.trim(),
        status: cover.querySelector(".loading-status")?.textContent.trim(),
        globe: Boolean(cover.querySelector(".loading-globe")),
        spinner: Boolean(cover.querySelector(".spinner")),
        background: getComputedStyle(cover).backgroundImage,
      };
    });
    if (loading.title !== "Journeys" || loading.status !== "Opening the archive") {
      throw new Error("loading identity is incomplete");
    }
    if (!loading.globe || loading.spinner) throw new Error("loading visual is not atlas-specific");
    if (!/linear-gradient/.test(loading.background)) throw new Error("loading veil is missing its twilight surface");
  });
  await page.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
  await page.waitForSelector("#loading", { hidden: true, timeout: 3000 });
  await wait(900);

  await check("landing globe + clear copy", async () => {
    const globePaths = await page.$$eval("#map .globe path", (e) => e.length);
    if (globePaths < 50) throw new Error("only " + globePaths + " globe paths");
    const lede = await page.$eval(".landing-card .lede", (el) => el.textContent.toLowerCase());
    if (!/survivor/.test(lede) || !/veteran/.test(lede)) throw new Error("lede missing survivors/veterans");
    const scale = await page.$eval(".scale", (el) => el.textContent.replace(/\s+/g, " ").trim());
    if (!/\d+ people/.test(scale)) throw new Error("scale='" + scale + "'");
    const icon = await page.$(".landing-card [data-act='follow'] .icon");
    if (!icon) throw new Error("primary action is missing its SVG icon");
    const motion = await page.evaluate(() => ({
      mode: document.documentElement.dataset.motion,
      mosaic: document.documentElement.dataset.mosaicMotion,
      version: window.gsap && window.gsap.version,
      hasReviewBadge: Boolean(document.querySelector(".status-pill")),
      mosaicTiles: document.querySelectorAll(".mosaic-tile:not([data-clone])").length,
      mosaicBelts: document.querySelectorAll(".mosaic-belt").length,
      beltsMoving: document.documentElement.dataset.mosaicBelts,
      mosaicPeople: [...document.querySelectorAll(".mosaic-tile:not([data-clone])")].reduce((total, tile) => (
        total + JSON.parse(tile.dataset.people || "[]").length
      ), 0),
      mosaicMissingPortraits: [...document.querySelectorAll(".mosaic-tile:not([data-clone])")].reduce((total, tile) => (
        total + JSON.parse(tile.dataset.people || "[]").filter((person) => !person.p).length
      ), 0),
      mosaicUnvalidatedPortraits: [...document.querySelectorAll(".mosaic-tile:not([data-clone])")].reduce((total, tile) => (
        total + JSON.parse(tile.dataset.people || "[]").filter((person) => !person.v).length
      ), 0),
      journeyCount: Number(document.querySelector(".metric b")?.textContent),
      mosaicHidden: document.querySelector("#portrait-field")?.getAttribute("aria-hidden"),
      globeRoutes: document.querySelectorAll(".globe-route").length,
      globeTravelers: document.querySelectorAll(".globe-traveler").length,
      firstTravelerX: Number(document.querySelector(".globe-traveler")?.getAttribute("cx")),
      globeCenterX: Number(document.querySelector(".globe-shell")?.getAttribute("cx")),
      globeCenterY: Number(document.querySelector(".globe-shell")?.getAttribute("cy")),
      graticule: document.querySelector(".globe-graticule")?.getAttribute("d"),
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      headerHeight: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--header-height")),
      headerCenter: document.querySelector(".topbar").getBoundingClientRect().height / 2,
      brandTitleCenter: (() => {
        const rect = document.querySelector(".brand-title").getBoundingClientRect();
        return rect.top + rect.height / 2;
      })(),
      motionControl: Boolean(document.querySelector("#motion-toggle")),
    }));
    if (motion.mode !== "gsap") throw new Error("GSAP motion mode is not active");
    if (motion.mosaic !== "animated") throw new Error("living mosaic is not animated");
    if (motion.version !== "3.15.0") throw new Error("unexpected GSAP version " + motion.version);
    if (motion.hasReviewBadge) throw new Error("header review badge should not render");
    if (motion.mosaicTiles < 64) throw new Error("living mosaic has too few tiles");
    if (motion.mosaicBelts !== 6 || motion.beltsMoving !== "rolling") throw new Error("portrait belts are not rolling");
    if (!motion.mosaicPeople || motion.mosaicPeople > motion.journeyCount) throw new Error("living mosaic portrait count is invalid");
    if (motion.mosaicMissingPortraits) throw new Error("initials-only records entered the landing mosaic");
    if (motion.mosaicUnvalidatedPortraits) throw new Error("non-face gallery assets entered the landing mosaic");
    if (motion.mosaicHidden !== "true") throw new Error("decorative mosaic is exposed to assistive technology");
    if (motion.globeRoutes < 5 || motion.globeTravelers < 5) throw new Error("landing globe journeys are missing");
    const expectedGlobeY = motion.headerHeight +
      (motion.viewportHeight - motion.headerHeight) / 2;
    if (Math.abs(motion.globeCenterX - motion.viewportWidth * .58) > 2 ||
        Math.abs(motion.globeCenterY - expectedGlobeY) > 2) {
      throw new Error("landing globe is not positioned correctly");
    }
    if (Math.abs(motion.brandTitleCenter - motion.headerCenter) > 2) {
      throw new Error("brand title is not vertically centered in the header");
    }
    if (motion.motionControl) throw new Error("motion control should not render");
    await wait(6200);
    const cadence = await page.$$eval(".mosaic-tile:not([data-clone])", (tiles) => ({
      changed: tiles.filter((tile) => Number(tile.dataset.swapCount) >= 1).length,
      total: tiles.length,
      intervals: tiles.map((tile) => Number(tile.dataset.cycleSeconds)),
    }));
    const travelerX = await page.$eval(".globe-traveler", (traveler) => Number(traveler.getAttribute("cx")));
    const graticule = await page.$eval(".globe-graticule", (grid) => grid.getAttribute("d"));
    if (cadence.changed !== cadence.total) throw new Error(`${cadence.total - cadence.changed} mosaic tiles did not change`);
    if (cadence.intervals.some((seconds) => seconds < 4.8 || seconds > 8.01)) {
      throw new Error("mosaic repeat interval is outside the expected range");
    }
    if (travelerX === motion.firstTravelerX) throw new Error("globe traveler did not move");
    if (graticule === motion.graticule) throw new Error("Earth graticule did not rotate");
  });
  await check("follow -> guided narrative + flat map", async () => {
    await page.click(".landing-card [data-act='follow']");
    await page.waitForSelector(".narr .chapter", { timeout: 5000 });
    if (await page.$(".follow-another")) throw new Error("Guided chooser should not render");
    const flatPaths = await page.$$eval("#map .camera path", (e) => e.length);
    if (flatPaths < 20) throw new Error("flat map not drawn (" + flatPaths + ")");
    const target = await page.evaluate(() => {
      const narrative = document.querySelector("[data-narr]");
      const chapters = [...narrative.querySelectorAll("[data-chapter]")];
      const last = Math.min(3, chapters.length - 1);
      if (last < 1) return -1;
      const activate = (index) => {
        const chapter = chapters[index];
        narrative.scrollTop = chapter.offsetTop -
          narrative.clientHeight / 2 + chapter.offsetHeight / 2;
        narrative.dispatchEvent(new Event("scroll"));
      };
      activate(last);
      activate(Math.max(0, last - 1));
      activate(last);
      return last;
    });
    if (target < 1) throw new Error("guided journey has no route to test");
    await wait(1000);
    const guidedRoute = await page.evaluate(() => {
      const active = Number(document.querySelector("[data-chapter].is-active")?.dataset.chapter);
      const paths = [...document.querySelectorAll("#map .guided-leg")];
      return {
        active,
        count: paths.length,
        unfinished: paths.filter((path) => Number(path.getAttribute("stroke-dashoffset")) > 0.1).length,
      };
    });
    if (guidedRoute.active !== target || guidedRoute.count !== target || guidedRoute.unfinished) {
      throw new Error(`unstable route state ${JSON.stringify(guidedRoute)}`);
    }
  });
  await check("explore: group chips + grouped rail", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .gchip", { timeout: 5000 });
    await page.waitForSelector(".rail .rail-ghead", { timeout: 5000 });
    const chips = await page.$$eval(".gchip", (e) => e.length);
    if (chips < 1) throw new Error("no group chips");
    const mapBounds = await page.$eval("#map", (map) => map.getBoundingClientRect().toJSON());
    await page.mouse.move(mapBounds.x + mapBounds.width / 2, mapBounds.y + mapBounds.height / 2);
    await page.mouse.wheel({ deltaY: -300 });
    await wait(250);
    const userTransform = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    await wait(850);
    const settledTransform = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    if (userTransform !== settledTransform) {
      throw new Error(`camera transition overrode user zoom (${userTransform} -> ${settledTransform})`);
    }
  });
  await check("search filters the rail", async () => {
    await page.type("#search", "auschwitz");
    await wait(350);
    const cnt = await page.$eval("[data-rail-count]", (el) => el.textContent);
    if (!/of \d+ shown/.test(cnt)) throw new Error("count='" + cnt + "'");
  });
  await check("select a person shows panel", async () => {
    await page.$eval("#search", (el) => { el.value = "Norman Baker"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await wait(250);
    await page.click(".rail .rail-card");
    await page.waitForSelector(".panel .journey", { timeout: 5000 });
    await page.waitForSelector(".panel .panel-group", { timeout: 3000 });
    await page.waitForSelector(".panel .service-context", { timeout: 3000 });
    const serviceMap = await page.evaluate(() => ({
      context: document.querySelector(".service-context strong")?.textContent,
      coalition: document.querySelectorAll("#map [data-war-side='coalition']").length,
      opposition: document.querySelectorAll("#map [data-war-side='opposition']").length,
    }));
    if (serviceMap.context !== "Second World War" || !serviceMap.coalition || !serviceMap.opposition) {
      throw new Error(`veteran service context is incomplete ${JSON.stringify(serviceMap)}`);
    }
  });
  await check("free zoom changes camera transform", async () => {
    await page.click(".panel-close").catch(() => {});
    await wait(200);
    const before = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    await page.mouse.move(760, 430);
    await page.mouse.wheel({ deltaY: -500 });
    await wait(400);
    const after = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    if (before === after) throw new Error("zoom did not change camera transform");
  });
  await check("patterns: historical events + timeline + density", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    await page.waitForSelector(".event-card", { timeout: 5000 });
    await page.waitForSelector(".pattern-event-marker", { timeout: 5000 });
    await page.waitForSelector("[data-war-context]", { timeout: 5000 });
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForFunction(
      () => document.documentElement.dataset.historicalBoundaries === "ready",
      { timeout: 15000 },
    );
    const yr = await page.$eval(".scrub-year", (el) => el.textContent);
    if (yr !== "1944") throw new Error("year=" + yr);
    const eventState = await page.evaluate(() => ({
      cards: document.querySelectorAll(".event-card").length,
      active: document.querySelectorAll(".event-card.on").length,
      markers: document.querySelectorAll(".pattern-event-marker").length,
      phase: document.querySelector(".war-brief > strong")?.textContent,
      territories: document.querySelectorAll(".historical-territory").length,
      canada: document.querySelector("[data-controller='Canada']")?.getAttribute("data-war-side"),
      germany: document.querySelector("[data-controller='Germany']")?.getAttribute("data-war-side"),
      occupied: document.querySelectorAll(".historical-territory[data-war-side='occupied']").length,
      veteranRoutes: document.querySelectorAll(".war-veteran-route").length,
    }));
    if (!eventState.cards || eventState.active !== 1 || eventState.markers < eventState.cards) {
      throw new Error("historical event browser is not synchronized");
    }
    if (eventState.phase !== "Liberation from west and east" ||
        eventState.canada !== "coalition" ||
        eventState.germany !== "opposition" ||
        eventState.territories < 140 ||
        !eventState.occupied ||
        !eventState.veteranRoutes) {
      throw new Error(`historical war layer is incomplete ${JSON.stringify(eventState)}`);
    }
    await page.$eval(".scrubber .range", (el) => { el.value = "1914"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const firstWorld = await page.evaluate(() => ({
      phase: document.querySelector(".war-brief > strong")?.textContent,
      austriaHungary: Boolean(document.querySelector("[data-territory='Austria-Hungary']")),
      hash: location.hash,
    }));
    if (firstWorld.phase !== "War begins in Europe" ||
        !firstWorld.austriaHungary ||
        firstWorld.hash !== "#/patterns/1914") {
      throw new Error(`1914 territory state is incorrect ${JSON.stringify(firstWorld)}`);
    }
    await page.$eval("[data-controller='United Kingdom']", (territory) => {
      territory.dispatchEvent(new MouseEvent("click", {
        bubbles: true,
        clientX: 800,
        clientY: 420,
      }));
    });
    const controlFocus = await page.evaluate(() => ({
      controlledAreas: document.querySelectorAll("[data-controller='United Kingdom']").length,
      focusedOpacity: document.querySelector("[data-controller='United Kingdom']")?.getAttribute("opacity"),
      otherOpacity: document.querySelector("[data-controller='Germany']")?.getAttribute("opacity"),
    }));
    if (controlFocus.controlledAreas < 10 ||
        controlFocus.focusedOpacity !== "0.96" ||
        controlFocus.otherOpacity !== "0.38") {
      throw new Error(`territorial control focus failed ${JSON.stringify(controlFocus)}`);
    }
    await page.$eval("[data-controller='United Kingdom']", (territory) => {
      territory.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.$eval(".scrubber .range", (el) => { el.value = "2026"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const present = await page.evaluate(() => ({
      phase: document.querySelector(".war-brief > strong")?.textContent,
      russia: Boolean(document.querySelector("[data-territory='Russia']")),
      ukraine: Boolean(document.querySelector("[data-territory='Ukraine']")),
      maximum: document.querySelector(".scrubber .range")?.max,
    }));
    if (present.phase !== "The map as it stands now" ||
        !present.russia || !present.ukraine || present.maximum !== "2026") {
      throw new Error(`current territory state is incorrect ${JSON.stringify(present)}`);
    }
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const beforeYear = Number(yr);
    await page.click("[data-act='next-year']");
    const nextYear = await page.$eval(".scrub-year", (el) => Number(el.textContent));
    if (nextYear !== beforeYear + 1) throw new Error("timeline did not advance exactly one year");
    await page.click(".seg[data-layer='origins']");
    await page.waitForSelector(".origin-list li", { timeout: 5000 });
  });
  await check("about renders", async () => {
    await page.click(".nav-plain[data-view='about']");
    await page.waitForSelector(".about-wrap .about-grid", { timeout: 5000 });
  });
  await check("patterns deep link opens at the 1944 war map", async () => {
    await page.goto(BASE + "/?deep-link=patterns#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("[data-war-context]", { timeout: 15000 });
    const state = await page.evaluate(() => ({
      year: document.querySelector(".scrub-year")?.textContent,
      phase: document.querySelector(".war-brief > strong")?.textContent,
      coalition: document.querySelectorAll("[data-war-side='coalition']").length,
    }));
    if (state.year !== "1944" || state.phase !== "Liberation from west and east" || !state.coalition) {
      throw new Error(`direct war map did not initialize ${JSON.stringify(state)}`);
    }
  });

  await page.setViewport({ width: 390, height: 844 });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
  await wait(300);

  await check("mobile landing uses a two-row shell without overflow", async () => {
    const layout = await page.evaluate(() => {
      const nav = document.querySelector(".nav").getBoundingClientRect();
      const brand = document.querySelector(".brand").getBoundingClientRect();
      return {
        navTop: nav.top,
        brandBottom: brand.bottom,
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
      };
    });
    if (layout.navTop < layout.brandBottom - 2) throw new Error("navigation overlaps the brand row");
    if (layout.scrollWidth > layout.viewport + 1) throw new Error(`horizontal overflow ${layout.scrollWidth}/${layout.viewport}`);
  });
  await check("mobile explore keeps the map visible", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .rail-card", { timeout: 5000 });
    await wait(750);
    const box = await page.$eval(".rail", (el) => el.getBoundingClientRect().toJSON());
    if (box.top < 220) throw new Error("explore sheet obscures too much of the map");
    if (box.bottom > 845) throw new Error("explore sheet overflows the viewport");
  });
  await check("mobile person detail is a closable bottom sheet", async () => {
    await page.$eval(".rail-card", (el) => el.click());
    await page.waitForSelector(".panel .journey", { timeout: 5000 });
    await wait(750);
    const detail = await page.$eval(".panel", (el) => {
      const box = el.getBoundingClientRect();
      return {
        top: box.top,
        bottom: box.bottom,
        hasCloseIcon: Boolean(el.querySelector(".panel-close .icon-close")),
      };
    });
    if (detail.top < 120) throw new Error("person sheet hides the entire map");
    if (detail.bottom > 845) throw new Error("person sheet overflows the viewport");
    if (!detail.hasCloseIcon) throw new Error("person sheet close action is not an SVG icon");
  });
  await check("mobile patterns separates insight and timeline", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    const layout = await page.evaluate(() => {
      const intro = document.querySelector(".patterns-intro").getBoundingClientRect();
      const scrubber = document.querySelector(".scrubber").getBoundingClientRect();
      return {
        introBottom: intro.bottom,
        scrubberTop: scrubber.top,
        scrubberLeft: scrubber.left,
        scrubberRight: scrubber.right,
        viewport: innerWidth,
      };
    });
    if (layout.introBottom > layout.scrubberTop - 12) throw new Error("patterns panels overlap");
    if (layout.scrubberLeft < 11 || layout.scrubberRight > layout.viewport - 11) {
      throw new Error("timeline is not centered within the viewport");
    }
  });
  await check("landing motion always starts without a control", async () => {
    const reduced = await browser.newPage();
    await reduced.setViewport({ width: 390, height: 844 });
    await reduced.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await reduced.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
    await reduced.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
    const result = await reduced.evaluate(() => {
      const title = document.querySelector(".landing-card .display");
      const style = getComputedStyle(title);
      return {
        mode: document.documentElement.dataset.motion,
        mosaic: document.documentElement.dataset.mosaicMotion,
        opacity: Number(style.opacity),
        visibility: style.visibility,
        belt: getComputedStyle(document.querySelector(".mosaic-track")).transform,
        traveler: Number(document.querySelector(".globe-traveler")?.getAttribute("cx")),
        control: Boolean(document.querySelector("#motion-toggle")),
      };
    });
    await wait(1200);
    const moved = await reduced.evaluate((before) => ({
      belt: getComputedStyle(document.querySelector(".mosaic-track")).transform !== before.belt,
      globe: Number(document.querySelector(".globe-traveler")?.getAttribute("cx")) !== before.traveler,
    }), result);
    await reduced.close();
    if (result.mode !== "gsap" || result.mosaic !== "animated") throw new Error("landing motion did not start");
    if (result.control) throw new Error("motion control should not render");
    if (result.opacity !== 1 || result.visibility !== "visible") {
      throw new Error("landing content is not immediately visible");
    }
    if (!moved.belt || !moved.globe) throw new Error("ambient landing motion is not active");
  });

  await browser.close();
  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
