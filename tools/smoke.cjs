// Headless smoke test for the world-atlas front end (globe landing, free zoom, search,
// group filters, density). Fails on any console error or uncaught exception.
const puppeteer = require("puppeteer-core");
const fs = require("node:fs");
const path = require("node:path");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:8124";

function assertCounterMotion(label, { targets, samples }) {
  if (targets.length !== 4 || !samples.length) {
    throw new Error(`${label} counter samples are incomplete`);
  }
  for (let index = 0; index < targets.length; index++) {
    const values = samples.map((sample) => sample[index]);
    if (!Number.isFinite(targets[index]) || values.some((value) => !Number.isFinite(value)) ||
        values[0] !== 0 ||
        values[values.length - 1] !== targets[index] ||
        values.some((value, sampleIndex) => sampleIndex && value < values[sampleIndex - 1])) {
      throw new Error(`${label} counter ${index} is not monotonic ${JSON.stringify(values)}`);
    }
  }
}

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 850 });
  await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
  let mockVideoPlayer = false;
  const coreData = (url) => /\/data\/(?:survivors\.geojson|place_index\.json|connections\.json|war_context\.json|historical_boundary_index\.json)(?:\?|$)/.test(url || "");
  const requestMeta = new WeakMap();
  const dataTransfers = new Map();
  let navigation = 0, requestOrder = 0;
  function trackData(request, failure = null) {
    const meta = requestMeta.get(request);
    if (!meta) { errors.push(`untracked data request: ${request.url()}`); return; }
    const key = `${meta.navigation}:${request.url()}`;
    if (!dataTransfers.has(key)) dataTransfers.set(key, { url: request.url(), failed: -1, completed: -1, reasons: [] });
    const transfer = dataTransfers.get(key);
    if (failure) {
      transfer.failed = Math.max(transfer.failed, meta.order);
      transfer.reasons.push(failure);
    } else transfer.completed = Math.max(transfer.completed, meta.order);
  }
  page.on("request", (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) navigation++;
    requestMeta.set(request, { navigation, order: ++requestOrder });
    if (request.interceptResolutionState().action === "disabled") return;
    if (mockVideoPlayer && request.url().startsWith("https://player.vimeo.com/video/")) {
      request.respond({ status: 200, contentType: "text/html", body: "<html><body>Interview player test</body></html>" });
      return;
    }
    request.continue();
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    // Network failures are checked for an actual same-navigation recovery below.
    if (coreData(m.location().url) && /^Failed to load resource:/.test(m.text())) return;
    errors.push("console: " + m.text());
  });
  page.on("response", (response) => {
    if (coreData(response.url()) && response.status() >= 400) trackData(response.request(), `HTTP ${response.status()}`);
  });
  page.on("requestfinished", (request) => {
    const response = request.response();
    if (coreData(request.url()) && (response?.ok() || response?.status() === 304)) trackData(request);
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + (e.stack || e.message)));
  page.on("requestfailed", (request) => {
    const reason = request.failure()?.errorText;
    // Scrubbing can remove an obsolete flag before its image request completes.
    if (!/favicon/.test(request.url()) && reason !== "net::ERR_ABORTED") {
      if (coreData(request.url())) trackData(request, reason || "network error");
      else errors.push(`requestfailed: ${request.url()} (${reason})`);
    }
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  const counterCapture = await page.evaluateOnNewDocument(() => {
    const samples = [];
    const capture = () => {
      const values = [...document.querySelectorAll("[data-counter]")]
        .map((counter) => Number(counter.textContent.replace(/,/g, "")));
      if (values.length && samples.length < 500) samples.push(values);
    };
    const observer = new MutationObserver(capture);
    observer.observe(document, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__initialCounterCapture = { observer, samples };
  });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.removeScriptToEvaluateOnNewDocument(counterCapture.identifier);
  await check("loading veil matches the atlas", async () => {
    await page.waitForSelector("#loading:not([hidden])", { timeout: 3000 });
    const loading = await page.evaluate(() => {
      const cover = document.querySelector("#loading");
      return {
        title: cover.querySelector(".loading-title")?.textContent.trim(),
        status: cover.querySelector(".loading-status")?.textContent.trim(),
        globe: Boolean(cover.querySelector(".loading-globe")),
        progressLine: Boolean(cover.querySelector(".loading-rule")),
        spinner: Boolean(cover.querySelector(".spinner")),
        background: getComputedStyle(cover).backgroundImage,
      };
    });
    if (loading.title !== "Journeys" || !["Opening the archive", "Reconnecting to the archive", "Opening the map"].includes(loading.status)) {
      throw new Error("loading identity is incomplete");
    }
    if (!loading.globe || loading.spinner || loading.progressLine) {
      throw new Error("loading visual is not a quiet atlas identity");
    }
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
    const register = await page.evaluate(() => ({
      items: document.querySelectorAll(".archive-register .register-item").length,
      values: [...document.querySelectorAll(".archive-register [data-counter]")]
        .map((element) => Number(element.dataset.counter)),
      legend: Boolean(document.querySelector(".legend-mini")),
      labelContrast: (() => {
        const luminance = (rgb) => rgb
          .map((channel) => channel / 255)
          .map((channel) => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4)
          .reduce((total, channel, index) => total + channel * [.2126, .7152, .0722][index], 0);
        const backdrop = [62, 79, 93];
        const surface = luminance(backdrop);
        return [...document.querySelectorAll(".register-head, .register-item > span")].map((element) => {
          const rgba = getComputedStyle(element).color.match(/[\d.]+/g).map(Number);
          const alpha = rgba[3] ?? 1;
          const foreground = luminance(rgba.slice(0, 3).map((channel, index) => (
            channel * alpha + backdrop[index] * (1 - alpha)
          )));
          return (Math.max(foreground, surface) + .05) / (Math.min(foreground, surface) + .05);
        });
      })(),
    }));
    if (register.items !== 4 || register.values.some((value) => !Number.isFinite(value))) {
      throw new Error(`archive register is incomplete ${JSON.stringify(register)}`);
    }
    if (register.legend) throw new Error("bottom-right landing legend should not render");
    if (register.labelContrast.some((ratio) => ratio < 4.5)) {
      throw new Error(`archive register labels lack contrast ${JSON.stringify(register.labelContrast)}`);
    }
    await wait(1400);
    const settledCounters = await page.$$eval("[data-counter]", (elements) => (
      elements.map((element) => ({
        text: Number(element.textContent.replace(/,/g, "")),
        target: Number(element.dataset.counter),
      }))
    ));
    if (settledCounters.some((counter) => counter.text !== counter.target)) {
      throw new Error(`archive counters did not settle ${JSON.stringify(settledCounters)}`);
    }
    const initialCounterMotion = await page.evaluate(() => {
      const capture = window.__initialCounterCapture;
      capture.observer.disconnect();
      return {
        samples: capture.samples,
        targets: [...document.querySelectorAll("[data-counter]")]
          .map((counter) => Number(counter.dataset.counter)),
      };
    });
    assertCounterMotion("initial landing", initialCounterMotion);
    const icon = await page.$(".landing-card [data-act='explore'] .icon");
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
      journeyCount: Number(document.querySelector("[data-counter]")?.dataset.counter),
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
    if (Math.abs(motion.globeCenterX - motion.viewportWidth * .72) > 2 ||
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
    if (cadence.intervals.some((seconds) => seconds < 8 || seconds > 13.61)) {
      throw new Error("mosaic repeat interval is outside the expected range");
    }
    if (travelerX === motion.firstTravelerX) throw new Error("globe traveler did not move");
    if (graticule === motion.graticule) throw new Error("Earth graticule did not rotate");
    await page.click(".nav-tab[data-view='explore']");
    await wait(100);
    const reentryCounterMotion = await page.evaluate(async () => {
      const samples = [];
      const capture = () => {
        const values = [...document.querySelectorAll("[data-counter]")]
          .map((counter) => Number(counter.textContent.replace(/,/g, "")));
        if (values.length) samples.push(values);
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.querySelector("#overlay"), {
        childList: true,
        subtree: true,
        characterData: true,
      });
      document.querySelector("[data-act='home']").click();
      capture();
      const targets = [...document.querySelectorAll("[data-counter]")]
        .map((counter) => Number(counter.dataset.counter));
      const deadline = performance.now() + 2100;
      while (performance.now() < deadline) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        capture();
      }
      observer.disconnect();
      return { targets, samples };
    });
    assertCounterMotion("landing re-entry", reentryCounterMotion);
    await page.click("[data-act='home']");
    const repeatedHome = await page.$$eval("[data-counter]", (elements) => (
      elements.every((element) => Number(element.textContent.replace(/,/g, "")) === Number(element.dataset.counter))
    ));
    if (!repeatedHome) throw new Error("clicking Home while at Home reset the register");
  });
  await check("Explore replaces Guided and old links still work", async () => {
    if (await page.$("[data-view='guided'], [data-guided], .narr")) {
      throw new Error("the removed Guided interface still exists");
    }
    await page.click(".landing-card [data-act='explore']");
    await page.waitForSelector(".rail-card");
    await page.goto(BASE + "/?old-route=1#/guided", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector(".rail-card", { timeout: 15000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 5000 });
    const state = await page.evaluate(() => ({
      view: document.body.dataset.view,
      hash: location.hash,
      tabs: [...document.querySelectorAll(".nav-tab")].map((button) => button.textContent),
    }));
    if (state.view !== "explore" || state.hash !== "#/explore" || state.tabs.length !== 2 ||
        state.tabs.includes("Guided")) {
      throw new Error(`old Guided route was not redirected ${JSON.stringify(state)}`);
    }
  });
  await check("all public records retain complete excerpts and media inventories", async () => {
    const inventory = await page.evaluate(async () => {
      const response = await fetch("data/survivors.geojson");
      if (!response.ok) throw new Error(`archive data returned ${response.status}`);
      const document = await response.json();
      const records = document.features.map((feature) => feature.properties);
      return {
        total: records.length,
        unplaced: records.filter((record) => !record.waypoints.length).map((record) => ({ id: record.survivor_id, name: record.name })),
        brokenBios: records.filter((record) => record.bio_excerpt && !/[.!?][\u201d\u2019"')\]]*$/.test(record.bio_excerpt)).map((record) => record.survivor_id),
        invalidMedia: records.filter((record) => (
          !record.profile_media || !Array.isArray(record.profile_media.images) || !Array.isArray(record.profile_media.videos) ||
          record.captioned_video_count > record.video_count ||
          record.profile_media.videos.length !== record.video_count
        )).map((record) => record.survivor_id),
      };
    });
    if (inventory.total < 1000 || !inventory.unplaced.length || inventory.brokenBios.length || inventory.invalidMedia.length) {
      throw new Error(`incomplete collection ${JSON.stringify(inventory)}`);
    }
    const unplaced = inventory.unplaced[0];
    await page.$eval("#search", (input, name) => {
      input.value = name; input.dispatchEvent(new Event("input", { bubbles: true }));
    }, unplaced.name);
    await page.click(`[data-survivor='${unplaced.id}']`);
    await page.waitForSelector(".profile-places .section-note", { timeout: 5000 });
    const note = await page.$eval(".profile-places .section-note", (element) => element.textContent);
    if (!note.includes("have not been mapped") || await page.$(".selected-place-ring")) {
      throw new Error("an unplaced account was given fabricated map geometry");
    }
    await page.click(".panel-close");
    await page.$eval("#search", (input) => {
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  await check("historical source aliases retain one readable account", async () => {
    await page.goto(BASE + "/?source-alias=1#/survivor/thomas-jack", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    const alias = await page.evaluate(() => ({
      hash: location.hash,
      name: document.querySelector("#profile-name")?.textContent,
      panels: document.querySelectorAll(".panel").length,
    }));
    if (alias.hash !== "#/survivor/thomas-jack-c" || !alias.name || alias.panels !== 1) {
      throw new Error(`the canonical profile alias was lost ${JSON.stringify(alias)}`);
    }
    await page.click(".panel-close");
  });
  await check("source context and location precision remain visible", async () => {
    await page.$eval("#search", (input) => {
      input.value = "Norman Baker"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("[data-survivor='baker-norman']");
    await page.waitForSelector(".contextual-places");
    const source = await page.evaluate(() => ({
      context: document.querySelector(".contextual-places").textContent,
      precision: [...document.querySelectorAll(".place-precision")].map((element) => element.textContent),
      needsReview: document.querySelectorAll(".place-review").length,
      firstPlace: document.querySelector(".place-focus .step-place")?.textContent,
    }));
    if (!source.context.includes("England") || !source.context.includes("Family background") ||
        source.firstPlace !== "Toronto, Canada" || !source.needsReview ||
        !source.precision.some((text) => text.includes("Country-level reference"))) {
      throw new Error(`source qualification is missing ${JSON.stringify(source)}`);
    }
    await page.click(".panel-close");
    await page.$eval("#search", (input) => {
      input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  });
  await check("keyboard skip keeps the current route and reaches main content", async () => {
    for (const selector of [".brand", ".nav-tab[data-view='patterns']", ".nav-plain[data-view='about']", ".nav-tab[data-view='explore']"]) {
      await page.click(selector);
      await wait(650);
      const hash = await page.evaluate(() => location.hash);
      await page.$eval(".skip-link", (link) => link.focus());
      await page.keyboard.press("Enter");
      await wait(100);
      const skipped = await page.evaluate(() => ({
        hash: location.hash,
        inMain: Boolean(document.activeElement.closest("main#overlay")),
        mapsAsApplications: document.querySelectorAll("#map[role='application']").length,
      }));
      if (skipped.hash !== hash || !skipped.inMain || skipped.mapsAsApplications) {
        throw new Error(`skip navigation changed the page ${JSON.stringify(skipped)}`);
      }
    }
  });
  await check("explore: native community filters and grouped rail", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .gchip", { timeout: 5000 });
    await page.waitForSelector(".rail .rail-ghead", { timeout: 5000 });
    const chips = await page.$$eval(".gchip", (e) => e.length);
    const profilePictures = await page.$$eval(".rail-card .medal img", (images) => images.length);
    if (chips < 1) throw new Error("no group chips");
    if (profilePictures < 100) throw new Error(`only ${profilePictures} profile pictures are available in the rail`);
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
  await check("collection filters, browse position and keyboard return", async () => {
    await page.click(".collection-filters summary");
    await page.click("[data-group='Military Veterans']");
    const filtered = await page.evaluate(() => ({
      selected: [...document.querySelectorAll("[data-group]:checked")].map((input) => input.dataset.group),
      groups: [...document.querySelectorAll(".rail-ghead")].map((element) => element.textContent.trim()),
    }));
    if (filtered.selected.length !== 4 || filtered.selected.includes("Military Veterans") ||
        filtered.groups.some((name) => name.startsWith("Military Veterans"))) {
      throw new Error(`community filter failed ${JSON.stringify(filtered)}`);
    }
    await page.click("[data-act='no-groups']");
    const empty = await page.evaluate(() => ({
      selected: document.querySelectorAll("[data-group]:checked").length,
      cards: document.querySelectorAll(".rail-card").length,
      markers: document.querySelectorAll("#map [data-person]").length,
      message: document.querySelector(".rail-empty p")?.textContent,
    }));
    if (empty.selected || empty.cards || empty.markers || empty.message !== "No communities selected") {
      throw new Error(`clearing communities silently restored results ${JSON.stringify(empty)}`);
    }
    await page.click("[data-group='Military Veterans']");
    if (await page.$$eval("[data-group]:checked", (inputs) => inputs.length) !== 1) {
      throw new Error("one checkbox did not select exactly one community");
    }
    await page.click("[data-group='Military Veterans']");
    if (await page.$(".rail-card")) throw new Error("unchecking the final community restored the whole collection");
    await page.click("[data-act='all-groups']");
    await page.$eval(".collection-filters", (details) => { details.open = true; });
    const source = await page.$eval("[data-rail-list]", (list) => {
      list.scrollTop = list.scrollHeight;
      const bounds = list.getBoundingClientRect();
      const card = [...list.querySelectorAll(".rail-card")].find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top >= bounds.top + 10 && rect.bottom < bounds.bottom - 10;
      });
      return { id: card.dataset.survivor, top: list.scrollTop };
    });
    await page.click(`[data-survivor='${source.id}']`);
    await page.waitForSelector(".panel");
    if (await page.$eval("#profile-name", (heading) => heading !== document.activeElement)) {
      throw new Error("profile heading did not receive keyboard focus");
    }
    await page.keyboard.press("Escape");
    const returned = await page.evaluate(() => ({
      panel: Boolean(document.querySelector(".panel")),
      top: document.querySelector("[data-rail-list]").scrollTop,
      focused: document.activeElement.dataset.survivor,
      filtersOpen: document.querySelector(".collection-filters").open,
    }));
    if (returned.panel || !returned.filtersOpen || Math.abs(returned.top - source.top) > 1 || returned.focused !== source.id) {
      throw new Error(`closing a profile lost the browse position ${JSON.stringify(returned)}`);
    }
    await page.$eval(".collection-filters", (details) => { details.open = false; });
    await page.$eval("[data-rail-list]", (list) => { list.scrollTop = 0; });
  });
  await check("search filters the rail", async () => {
    await page.type("#search", "auschwitz");
    await wait(350);
    const cnt = await page.$eval("[data-rail-count]", (el) => el.textContent);
    if (!/of \d+ shown/.test(cnt)) throw new Error("count='" + cnt + "'");
    await page.$eval("#search", (input) => {
      input.value = "no-such-archive-record-9381";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.click("[data-act='reset-search']");
    const reset = await page.evaluate(() => ({
      query: document.querySelector("#search").value,
      focused: document.activeElement.id,
      people: document.querySelectorAll(".rail-card").length,
    }));
    if (reset.query || reset.focused !== "search" || reset.people !== 140) {
      throw new Error(`empty search recovery failed ${JSON.stringify(reset)}`);
    }
  });
  await check("select a person shows panel", async () => {
    await page.$eval("#search", (el) => { el.value = "Norman Baker"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await wait(250);
    await page.click(".rail .rail-card");
    await page.waitForSelector(".panel .journey", { timeout: 5000 });
    await page.waitForSelector(".panel .panel-group", { timeout: 3000 });
    await page.waitForSelector(".panel .recording-meta", { timeout: 3000 });
    const serviceMap = await page.evaluate(() => ({
      guessedContext: Boolean(document.querySelector(".service-context")),
      bio: document.querySelector(".panel .bio")?.textContent.trim(),
      recording: document.querySelector(".panel .recording-meta")?.textContent.replace(/\s+/g, " ").trim(),
      restoredPicture: Boolean(document.querySelector(".panel .medal img")),
    }));
    if (serviceMap.guessedContext || serviceMap.bio.length < 200 || /…$/.test(serviceMap.bio) ||
        !/[.!?][”"')\]]?$/.test(serviceMap.bio) ||
        !/This interview has \d+ chapters?\./.test(serviceMap.recording || "") ||
        !serviceMap.restoredPicture) {
      throw new Error(`veteran service context is incomplete ${JSON.stringify(serviceMap)}`);
    }
    await page.setViewport({ width: 1200, height: 800 });
    await wait(1300);
    const reframed = await page.$eval("#map .camera", (camera) => Number(
      camera.getAttribute("transform").match(/scale\(([^)]+)\)/)[1],
    ));
    if (reframed <= 1.01) throw new Error("resizing lost the selected account's map framing");
    await page.setViewport({ width: 1366, height: 850 });
    await wait(1300);
  });
  await check("account navigation stays visible and browser Back restores the collection", async () => {
    await page.click(".profile-heading");
    if (!await page.$(".panel")) throw new Error("clicking ordinary profile content closed the account");
    await page.$eval(".panel", (panel) => { panel.scrollTop = panel.scrollHeight; });
    const toolbar = await page.evaluate(() => {
      const panel = document.querySelector(".panel").getBoundingClientRect();
      const bar = document.querySelector(".profile-toolbar").getBoundingClientRect();
      return {
        top: bar.top, bottom: bar.bottom, panelTop: panel.top,
        routes: document.querySelector(".profile-route-status").textContent,
        backgroundPeople: document.querySelectorAll("#map [data-person]").length,
      };
    });
    if (toolbar.top < toolbar.panelTop - 1 || toolbar.bottom > toolbar.panelTop + 110 ||
        toolbar.backgroundPeople || !toolbar.routes.includes("not exact travel paths")) {
      throw new Error(`reader navigation or map context is unclear ${JSON.stringify(toolbar)}`);
    }
    for (const section of ["profile-photographs", "profile-interviews", "profile-story"]) {
      await page.click(`[data-profile-section='${section}']`);
      await wait(700);
      const target = await page.$eval(`#${section}`, (element) => ({
        focused: document.activeElement.id,
        top: element.getBoundingClientRect().top,
        toolbarBottom: document.querySelector(".profile-toolbar").getBoundingClientRect().bottom,
      }));
      if (target.focused !== section || target.top < target.toolbarBottom + 8) {
        throw new Error(`section shortcut hides its target ${section} ${JSON.stringify(target)}`);
      }
    }
    await page.goBack();
    await page.waitForFunction(() => location.hash.startsWith("#/explore") && !document.querySelector(".panel"));
    if (await page.$eval("#search", (input) => input.value) !== "Norman Baker") {
      throw new Error("browser Back lost the collection search");
    }
    await page.click("[data-survivor='baker-norman']");
    await page.click(".nav-tab[data-view='explore']");
    if (await page.$(".panel")) throw new Error("Explore reopened the selected profile instead of the collection");
    await page.click("[data-survivor='baker-norman']");
  });
  await check("unmapped accounts explain the missing route beside the identity", async () => {
    await page.evaluate(() => { location.hash = "#/survivor/aldous-amanda"; });
    await page.waitForFunction(() => document.getElementById("profile-name")?.textContent === "Amanda Aldous");
    const unmapped = await page.evaluate(() => ({
      notice: document.querySelector(".profile-route-status").textContent,
      noticeTop: document.querySelector(".profile-route-status").getBoundingClientRect().top,
      sourceTop: document.querySelector(".profile-actions").getBoundingClientRect().top,
      drawn: document.querySelectorAll("#map .explore-route, #map [data-person]").length,
      action: document.querySelector(".interview-action").textContent.trim(),
      chapterNote: document.querySelector(".profile-interviews .section-note").textContent,
    }));
    if (unmapped.notice !== "No places have been mapped for this account." || unmapped.drawn ||
        unmapped.noticeTop >= unmapped.sourceTop || unmapped.action !== "View interview chapters" ||
        !unmapped.chapterNote.includes("access may also be restricted")) {
      throw new Error(`unmapped or external-only account overpromises ${JSON.stringify(unmapped)}`);
    }
  });
  await check("caption statuses distinguish inaccessible and captionless videos", async () => {
    const coverage = await page.evaluate(async () => {
      const { captionStatus, normalizeProfileMedia, playerURL } = await import("./js/media.js");
      const media = normalizeProfileMedia({ videos: [{
        id: "123", url: "https://vimeo.com/123",
        embed_url: "https://player.vimeo.com/video/123?h=public-hash",
        status: "captioned",
      }] });
      return {
        unavailable: captionStatus({ status: "unavailable" }),
        none: captionStatus({ status: "no-public-captions" }),
        pending: captionStatus({ status: "error" }),
        embed: playerURL(media.videos[0]),
      };
    });
    if (coverage.unavailable === coverage.none || !coverage.unavailable.includes("original OHP page") ||
        !coverage.pending.includes("not been confirmed") ||
        !coverage.embed.includes("h=public-hash") || !coverage.embed.includes("dnt=1")) {
      throw new Error(`caption or public embed handling is incorrect ${JSON.stringify(coverage)}`);
    }
  });
  await check("captioned veteran shows audited chapter coverage", async () => {
    await page.$eval("#search", (input) => {
      input.value = "Wally Adam";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(250);
    await page.waitForSelector("[data-survivor='adam-wally']", { timeout: 3000 });
    await page.click("[data-survivor='adam-wally']");
    await page.waitForSelector(".panel .recording-meta", { timeout: 3000 });
    const selectedName = await page.$eval(".panel .serif-lg", (element) => element.textContent.trim());
    if (selectedName !== "Wally Adam") throw new Error(`selected ${selectedName} instead of Wally Adam`);
    if (await page.$(".service-context")) throw new Error("a war mentioned in childhood was labelled as personal service");
    const inferredService = await page.evaluate(async () => {
      const { loadData } = await import("./js/data.js");
      const archive = await loadData();
      const person = archive.byId.get("adam-wally");
      return { conflicts: person.serviceConflicts, year: person.serviceYear };
    });
    if (inferredService.conflicts.length || inferredService.year != null) {
      throw new Error("birth/family war mentions were used as dated service evidence");
    }
    const coverage = await page.$eval(
      ".panel .recording-meta",
      (element) => element.textContent.replace(/\s+/g, " ").trim(),
    );
    if (!/This interview has \d+ chapters?\./.test(coverage) || !/Public captions are available/.test(coverage)) {
      throw new Error(`caption coverage is incorrect: ${coverage}`);
    }
    const miniRoutes = await page.$$eval(".panel .mini path", (paths) => (
      paths.map((path) => ({
        moves: (path.getAttribute("d").match(/M/g) || []).length,
        join: path.getAttribute("stroke-linejoin"),
      }))
    ));
    if (miniRoutes.length !== 1 || miniRoutes[0].moves !== 1 || miniRoutes[0].join !== "round") {
      throw new Error(`mini route is segmented ${JSON.stringify(miniRoutes)}`);
    }
    await page.click("[data-act='show-interviews']");
    await page.waitForSelector(".video-chapter");
    const media = await page.evaluate(() => ({
      chapters: document.querySelectorAll(".video-chapter").length,
      iframe: Boolean(document.querySelector(".player-frame iframe")),
      focused: document.activeElement.id,
    }));
    if (media.chapters < 1 || media.iframe || media.focused !== "interviews-title") {
      throw new Error(`interview chapters are not accessible or loaded without consent ${JSON.stringify(media)}`);
    }
    mockVideoPlayer = true;
    await page.setRequestInterception(true);
    try {
      await page.click(".video-chapter[data-video]");
      await page.waitForSelector(".player-frame iframe");
      const player = await page.$eval(".player-frame iframe", (frame) => ({
        src: frame.src, title: frame.title, count: document.querySelectorAll(".player-frame iframe").length,
      }));
      if (!player.src.startsWith("https://player.vimeo.com/video/") || !player.src.includes("dnt=1") ||
          !player.title.includes("Wally Adam") || player.count !== 1) {
        throw new Error(`the interview player is not wired correctly ${JSON.stringify(player)}`);
      }
      await page.$eval(".player-frame iframe", (frame) => { frame.dataset.preserved = "yes"; });
      await page.$eval(".collection-filters", (details) => { details.open = true; });
      await page.click("[data-group='Community Members']");
      if (await page.$eval(".player-frame iframe", (frame) => frame.dataset.preserved) !== "yes") {
        throw new Error("changing collection filters interrupted the interview player");
      }
      await page.click("[data-act='all-groups']");
      await page.$eval(".collection-filters", (details) => { details.open = false; });
      await page.keyboard.press("Escape");
      const escaped = await page.evaluate(() => ({
        name: document.getElementById("profile-name")?.textContent,
        player: Boolean(document.querySelector(".player-frame iframe")),
        chapter: document.activeElement.dataset.video,
      }));
      if (escaped.name !== "Wally Adam" || escaped.player || !escaped.chapter) {
        throw new Error(`Escape left the account instead of closing its video ${JSON.stringify(escaped)}`);
      }
      await page.keyboard.press("Enter");
      await page.waitForSelector(".player-frame iframe");
      await page.click("[data-act='close-video']");
      if (await page.$(".player-frame iframe")) throw new Error("closing the player left a video running");
    } finally {
      mockVideoPlayer = false;
      await page.setRequestInterception(false);
    }
    await page.click("[data-place-step='0']");
    await page.waitForSelector(".selected-place-ring");
    const passages = await page.$$eval(".place-account", (elements) => elements.map((element) => element.textContent.trim()));
    if (passages.some((passage) => !/[.!?][\u201d\u2019"')\]]*$/.test(passage))) {
      throw new Error("a profile still displays a cut-off source passage");
    }
    const exploreRoutes = await page.$$eval("#map .explore-route", (paths) => (
      paths.map((path) => (path.getAttribute("d").match(/M/g) || []).length)
    ));
    if (exploreRoutes.length !== 1 || exploreRoutes[0] !== 1) {
      throw new Error(`explore route is segmented ${JSON.stringify(exploreRoutes)}`);
    }
  });
  await check("free zoom changes camera transform", async () => {
    if (await page.$(".panel-close")) await page.click(".panel-close");
    await wait(200);
    const before = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    await page.mouse.move(760, 430);
    await page.mouse.wheel({ deltaY: -500 });
    await wait(400);
    const after = await page.$eval("#map .camera", (g) => g.getAttribute("transform") || "");
    if (before === after) throw new Error("zoom did not change camera transform");
    await page.click("[data-act='zoom-in']");
    await wait(400);
    const zoomed = await page.$eval("#map .camera", (g) => g.getAttribute("transform"));
    if (zoomed === after) throw new Error("zoom-in control did not change the camera");
    await page.click("[data-act='zoom-out']");
    await wait(400);
    await page.click("[data-act='reset-map']");
    await wait(1000);
    const fitted = await page.$eval("#map .camera", (g) => g.getAttribute("transform"));
    if (fitted !== "translate(0,0) scale(1)") throw new Error(`fit map failed ${fitted}`);
  });
  await check("patterns: historical events + timeline + density", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    await page.waitForSelector(".testimony-moment", { timeout: 5000 });
    await page.waitForSelector(".pattern-event-marker", { timeout: 5000 });
    await page.waitForSelector("[data-war-context]", { timeout: 5000 });
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForFunction(
      () => document.documentElement.dataset.historicalBoundaries === "ready",
      { timeout: 15000 },
    );
    const yr = await page.$eval(".scrub-year", (el) => el.value);
    if (yr !== "1944") throw new Error("year=" + yr);
    const eventState = await page.evaluate(() => ({
      markers: document.querySelectorAll(".pattern-event-marker").length,
      activeMarkers: [...document.querySelectorAll(".pattern-event-marker")]
        .filter((marker) => marker.getAttribute("fill") === getComputedStyle(document.documentElement).getPropertyValue("--accent-deep").trim()).length,
      phase: document.querySelector(".war-brief-content > strong")?.textContent,
      territories: document.querySelectorAll(".historical-territory").length,
      canada: document.querySelector("[data-controller='Canada']")?.getAttribute("data-war-side"),
      germany: document.querySelector("[data-controller='Germany']")?.getAttribute("data-war-side"),
      occupied: document.querySelectorAll(".historical-territory[data-war-side='occupied']").length,
      corridors: document.querySelectorAll(".service-corridor").length,
      corridorEvidence: [...document.querySelectorAll(".service-corridor")]
        .every((element) => element.__data__.year === 1944 && element.__data__.count > 1),
      routeAvailability: document.querySelector("[data-route-availability]")?.textContent,
      selectedRoutes: document.querySelectorAll(".selected-testimony-route").length,
    }));
    if (!eventState.markers || eventState.activeMarkers || eventState.selectedRoutes) {
      throw new Error("historical event layer should open without a forced selection");
    }
    if (eventState.phase !== "Allied armies advance from west and east" ||
        eventState.canada !== "coalition" ||
        eventState.germany !== "opposition" ||
        eventState.territories < 140 ||
        !eventState.occupied ||
        !eventState.corridorEvidence ||
        (!eventState.corridors && !/No shared city\/site routes/.test(eventState.routeAvailability || "")) ||
        eventState.corridors > 8) {
      throw new Error(`historical war layer is incomplete ${JSON.stringify(eventState)}`);
    }
    await page.$eval(".pattern-event-marker", (marker) => {
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector(".testimony-moment.is-selected", { timeout: 3000 });
    const selection = await page.evaluate(async () => {
      const { loadData } = await import("./js/data.js");
      const store = await loadData();
      const ids = [...document.querySelectorAll(".testimony-moment .event-person")].slice(0, 4).map((button) => button.dataset.survivor);
      const paths = [...document.querySelectorAll(".selected-testimony-route")];
      return {
        expectedRoutes: ids.filter((id) => store.byId.get(id).routeWaypoints.filter((place) => place.historyYear === 1944).length > 1).length,
        selectedRoutes: paths.length,
        invalidRoutes: paths.some((path) => path.__data__.waypoints.some((place) => place.historyYear !== 1944 ||
          (!place.verified && place.evidenceScope !== "personal") || ["country", "region"].includes(place.locationPrecision))),
        peoplePaired: [...document.querySelectorAll(".testimony-moment .event-person")].every((button) =>
          button.querySelector(".event-avatar .medal") &&
          button.querySelector(".event-person-name")?.textContent === store.byId.get(button.dataset.survivor).name),
        segmentedRoutes: paths.filter((path) => (path.getAttribute("d").match(/M/g) || []).length !== 1).length,
        place: document.querySelector(".testimony-moment.is-selected > strong")?.textContent,
        eventPosition: document.querySelector(".moment-nav b")?.textContent,
      };
    });
    if (selection.selectedRoutes !== selection.expectedRoutes || selection.invalidRoutes || selection.segmentedRoutes || !selection.peoplePaired ||
        !selection.place || !/\d+ \/ \d+/.test(selection.eventPosition || "")) {
      throw new Error(`testimony selection did not reveal focused detail ${JSON.stringify(selection)}`);
    }
    await page.$eval(".scrubber .range", (el) => { el.value = "1914"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const firstWorld = await page.evaluate(() => ({
      phase: document.querySelector(".war-brief-content > strong")?.textContent,
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
      phase: document.querySelector(".war-brief-content > strong")?.textContent,
      russia: Boolean(document.querySelector("[data-territory='Russia']")),
      ukraine: Boolean(document.querySelector("[data-territory='Ukraine']")),
      maximum: document.querySelector(".scrubber .range")?.max,
    }));
    if (present.phase !== "Current boundaries" ||
        !present.russia || !present.ukraine || present.maximum !== "2026") {
      throw new Error(`current territory state is incorrect ${JSON.stringify(present)}`);
    }
    await page.$eval(".scrubber .range", (el) => { el.value = "1960"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const decolonization = await page.evaluate(() => ({
      phase: document.querySelector(".war-brief-content > strong")?.textContent,
      copy: document.querySelector(".war-brief-content > p")?.textContent,
      map: document.querySelector(".war-brief-map")?.getAttribute("src"),
      footer: document.querySelector(".war-brief-content > small")?.textContent.replace(/\s+/g, " ").trim(),
    }));
    if (decolonization.phase !== "Empires recede" ||
        !/Africa and Asia/.test(decolonization.copy || "") ||
        decolonization.map !== "assets/history/atlas-1960.svg" ||
        !/territories, \d+ changes/.test(decolonization.footer || "")) {
      throw new Error(`1960 dossier is incomplete ${JSON.stringify(decolonization)}`);
    }
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const beforeYear = Number(yr);
    await page.$eval("[data-act='next-year']", (button) => button.click());
    const nextYear = await page.$eval(".scrub-year", (el) => Number(el.value));
    if (nextYear !== beforeYear + 1) {
      throw new Error(`timeline did not advance exactly one year (${beforeYear} -> ${nextYear})`);
    }
    await page.$eval(".seg[data-layer='origins']", (button) => button.click());
    await page.waitForSelector(".origin-list li", { timeout: 5000 });
  });
  await check("country search opens a sourced, dated flag inspector", async () => {
    await page.click(".seg[data-layer='journeys']");
    await page.waitForSelector("[data-country-search]");
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1944";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.type("[data-country-search]", "Canada");
    await page.click("[data-history-search] button");
    await page.waitForSelector(".country-inspector");
    await page.waitForFunction(() => {
      const image = document.querySelector(".country-flag");
      return image?.complete && image.naturalWidth > 0;
    });
    const before = await page.evaluate(() => ({
      title: document.querySelector(".country-heading h3").textContent,
      flag: document.querySelector(".country-flag").getAttribute("src"),
      source: document.querySelector(".flag-note a").href,
      areas: document.querySelectorAll(".country-areas li").length,
      hash: location.hash,
    }));
    if (before.title !== "Canada" || !before.areas || !before.source.startsWith("https://") ||
        !before.hash.includes("country=Canada")) {
      throw new Error(`country inspector is incomplete ${JSON.stringify(before)}`);
    }
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1966";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.waitForFunction((src) => document.querySelector(".country-flag")?.getAttribute("src") !== src, {}, before.flag);
    if (!(await page.$(".historical-flag"))) throw new Error("verified historical flags are absent from the map");
    await page.click("[data-act='clear-country']");
    if (await page.$(".country-inspector")) throw new Error("country focus did not close");
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1944"; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.$eval("[data-country-search]", (input) => { input.value = "USSR"; });
    await page.click("[data-history-search] button");
    const soviet = await page.evaluate(() => ({
      name: document.querySelector(".country-heading h3")?.textContent,
      flag: document.querySelector(".country-flag")?.getAttribute("src"),
    }));
    if (soviet.name !== "Soviet Union" || !/soviet-union/.test(soviet.flag || "")) {
      throw new Error(`a modern controller label replaced the historical entity ${JSON.stringify(soviet)}`);
    }
    const alternatives = await page.evaluate(() => ({
      warning: document.querySelector(".country-inspector .source-caution")?.textContent,
      outlines: document.querySelectorAll("[data-boundary-uncertain='true'][stroke-dasharray]").length,
    }));
    if (!alternatives.warning?.includes("overlap") || !alternatives.outlines) {
      throw new Error("overlapping historical source records are being shown as certain");
    }
    await page.click("[data-act='clear-country']");
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1960"; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.$eval("[data-country-search]", (input) => { input.value = "East Germany"; });
    await page.click("[data-history-search] button");
    const east = await page.evaluate(() => ({
      name: document.querySelector(".country-heading h3")?.textContent,
      flag: document.querySelector(".country-flag")?.getAttribute("src"),
    }));
    if (east.name !== "East Germany" || !/germany-east-1959/.test(east.flag || "")) {
      throw new Error(`East Germany was collapsed into the federal state ${JSON.stringify(east)}`);
    }
    await page.click("[data-act='clear-country']");
  });
  await check("history search asks about ambiguity and clears obsolete selections", async () => {
    await page.type("[data-country-search]", "united");
    await page.click("[data-history-search] button");
    await page.waitForSelector("[data-history-results]:not([hidden])");
    const choices = await page.$$eval("[data-history-match]", (buttons) => buttons.map((button) => ({
      index: button.dataset.historyMatch, name: button.querySelector("span").textContent,
    })));
    if (choices.length < 2 || await page.$(".country-inspector")) {
      throw new Error("an ambiguous name silently selected the first match");
    }
    const uk = choices.find((choice) => choice.name === "United Kingdom");
    if (!uk) throw new Error("the disambiguation list omitted the United Kingdom");
    await page.click(`[data-history-match='${uk.index}']`);
    await page.click("[data-country-search]");
    await page.keyboard.down("Control"); await page.keyboard.press("KeyA"); await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    const cleared = await page.evaluate(() => ({
      country: Boolean(document.querySelector(".country-inspector")),
      query: document.querySelector("[data-country-search]").value,
      hash: location.hash,
    }));
    if (cleared.country || cleared.query || cleared.hash.includes("country=")) {
      throw new Error(`clearing search retained the selection ${JSON.stringify(cleared)}`);
    }
    await page.type("[data-country-search]", "East Germany");
    await page.click("[data-history-search] button");
    await page.waitForSelector(".country-inspector");
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1992"; input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const changedYear = await page.evaluate(() => ({
      country: Boolean(document.querySelector(".country-inspector")),
      query: document.querySelector("[data-country-search]").value,
      message: document.querySelector("[data-search-status]").textContent,
      hash: location.hash,
    }));
    if (changedYear.country || changedYear.query || changedYear.hash.includes("country=") ||
        !changedYear.message.includes("East Germany has no mapped territory in 1992")) {
      throw new Error(`changing the year silently lost the country ${JSON.stringify(changedYear)}`);
    }
  });
  await check("origin charts open exact, shareable account cohorts", async () => {
    await page.click("[data-layer='origins']");
    await page.click("[data-origin='Canada']");
    await page.waitForSelector("[data-origin-filter]:not([hidden])");
    const cohort = await page.evaluate(async () => {
      const { loadData, journeyFilter } = await import("./js/data.js");
      const store = await loadData();
      const expected = store.journeys.filter((journey) => journey.originCountry === "Canada").map((journey) => journey.id);
      const mentions = store.journeys.filter(journeyFilter({
        query: "Canada", groupFilter: new Set(store.groups.map((group) => group.name)),
      })).length;
      return {
        expected, mentions,
        markers: [...document.querySelectorAll("#map [data-person]")].map((marker) => marker.dataset.person),
        cards: [...document.querySelectorAll(".rail-card")].map((card) => card.dataset.survivor),
        count: document.querySelector("[data-rail-count]").textContent,
        hash: location.hash,
      };
    });
    if (cohort.mentions <= cohort.expected.length ||
        cohort.markers.length !== cohort.expected.length ||
        cohort.markers.concat(cohort.cards).some((id) => !cohort.expected.includes(id)) ||
        !cohort.count.includes(`of ${cohort.expected.length} shown`) || !cohort.hash.includes("origin=Canada")) {
      throw new Error(`the origin chart opened a general text search ${JSON.stringify(cohort)}`);
    }
    await page.goto(BASE + "/?origin-cohort=1" + cohort.hash, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    if (await page.$eval("[data-origin-name]", (name) => name.textContent) !== "Canada") {
      throw new Error("the origin cohort did not survive a shared-link reload");
    }
    await page.click(".rail-card");
    await page.click(".panel-close");
    if (await page.$eval("[data-origin-filter]", (filter) => filter.hidden)) {
      throw new Error("closing an account lost its origin cohort");
    }
    await page.click("[data-act='origin-overview']");
    await page.click("[data-layer='journeys']");
  });
  await check("historical layer controls and comparison are functional", async () => {
    await page.$eval("[data-year-entry]", (input) => {
      input.value = "1944";
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await page.click(".history-settings > summary");
    await page.click("[data-history-setting='compare']");
    await page.$eval("[data-history-opacity]", (input) => {
      input.value = "0.6"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.$eval("[data-history-split]", (input) => {
      input.value = "70"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const comparison = await page.evaluate(() => ({
      comparing: document.querySelector("#map").dataset.comparing,
      clip: document.querySelector(".historical-territories").getAttribute("clip-path"),
      width: Number(document.querySelector("#history-comparison-clip rect").getAttribute("width")),
      opacity: Number(document.querySelector(".historical-territories").style.opacity),
      modern: getComputedStyle(document.querySelector(".modern-countries")).display,
      caption: !document.querySelector("[data-compare-caption]").hidden,
    }));
    if (comparison.comparing !== "true" || !comparison.clip || comparison.width <= 0 ||
        comparison.opacity !== .6 || comparison.modern === "none" || !comparison.caption) {
      throw new Error(`comparison did not apply ${JSON.stringify(comparison)}`);
    }
    for (const setting of ["flags", "routes", "testimony"]) await page.click(`[data-history-setting='${setting}']`);
    const hidden = await page.evaluate(() => ({
      flags: document.querySelectorAll(".historical-flag").length,
      routes: document.querySelectorAll(".service-corridor").length,
      places: document.querySelectorAll(".pattern-event-marker").length,
    }));
    if (hidden.flags || hidden.routes || hidden.places) throw new Error(`hidden layers still render ${JSON.stringify(hidden)}`);
    for (const setting of ["flags", "routes", "testimony"]) await page.click(`[data-history-setting='${setting}']`);
    await page.keyboard.press("Escape");
    if (await page.$(".history-settings[open]")) throw new Error("Escape did not close map settings");
  });
  await check("shared maps restore the year, layers and camera", async () => {
    await page.click("[data-act='zoom-in']");
    await wait(400);
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => { throw new DOMException("Permission denied", "NotAllowedError"); } },
      });
    });
    await page.click("[data-act='share-map']");
    if (await page.$eval("[data-share-address]", (input) => input.hidden || !input.value.startsWith(location.origin))) {
      throw new Error("blocked clipboard did not offer a selectable map link");
    }
    await page.evaluate(() => {
      window.__copiedMap = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (value) => { window.__copiedMap = value; } },
      });
    });
    await page.click("[data-act='share-map']");
    if (!await page.$eval("[data-share-address]", (input) => input.hidden)) {
      throw new Error("successful copying left a stale fallback input visible");
    }
    const copied = await page.evaluate(() => window.__copiedMap);
    const hash = new URL(copied).hash;
    const params = new URLSearchParams(hash.split("?")[1]);
    if (!hash.startsWith("#/patterns/1944?") || !params.has("lng") || !params.has("lat") ||
        params.get("compare") !== "1" || params.get("split") !== "70") {
      throw new Error(`the map link omitted its state ${hash}`);
    }
    await page.goto(BASE + "/?restore-view=1" + hash, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready", { timeout: 15000 });
    await wait(1100);
    const restored = await page.evaluate(() => ({
      year: document.querySelector("[data-year-entry]").value,
      comparison: document.querySelector("#map").dataset.comparing,
      opacity: Number(document.querySelector(".historical-territories").style.opacity),
      scale: Number(document.querySelector(".camera").getAttribute("transform").match(/scale\(([^)]+)\)/)[1]),
    }));
    if (restored.year !== "1944" || restored.comparison !== "true" ||
        restored.opacity !== .6 || Math.abs(restored.scale - Number(params.get("zoom"))) > .01) {
      throw new Error(`the shared map state was lost ${JSON.stringify(restored)}`);
    }
  });
  await check("historical playback advances and pauses", async () => {
    await page.click("[data-act='play-history']");
    const first = await page.$eval("[data-year-entry]", (input) => Number(input.value));
    await page.waitForFunction((before) => Number(document.querySelector("[data-year-entry]").value) > before, { timeout: 5000 }, first);
    await page.click("[data-act='play-history']");
    const paused = await page.$eval("[data-year-entry]", (input) => Number(input.value));
    await wait(1400);
    if (await page.$eval("[data-year-entry]", (input) => Number(input.value)) !== paused) {
      throw new Error("the historical timeline did not pause");
    }
  });
  await check("about renders", async () => {
    await page.click(".nav-plain[data-view='about']");
    await page.waitForSelector(".about-wrap .about-grid", { timeout: 5000 });
    const about = await page.evaluate(() => ({
      sources: document.querySelectorAll(".about-sources dd").length,
      communities: document.querySelectorAll(".collection-ledger dd").length,
      current: document.querySelector("[aria-current='page']")?.dataset.view,
      audit: document.querySelector(".geometry-audit dd")?.textContent,
      technical: document.querySelector(".geometry-audit a[download]")?.textContent,
    }));
    if (about.sources < 7 || about.communities !== 5 || about.current !== "about" ||
        about.audit !== "1,181" || !about.technical?.includes("(JSON)")) {
      throw new Error(`archive source ledger is incomplete ${JSON.stringify(about)}`);
    }
  });
  await check("patterns deep link opens at the 1944 war map", async () => {
    await page.goto(BASE + "/?deep-link=patterns#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("[data-war-context]", { timeout: 15000 });
    const state = await page.evaluate(() => ({
      year: document.querySelector(".scrub-year")?.value,
      phase: document.querySelector(".war-brief-content > strong")?.textContent,
      coalition: document.querySelectorAll("[data-war-side='coalition']").length,
    }));
    if (state.year !== "1944" || state.phase !== "Allied armies advance from west and east" || !state.coalition) {
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
      const register = document.querySelector(".register-grid");
      return {
        navTop: nav.top,
        brandBottom: brand.bottom,
        viewport: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        registerColumns: getComputedStyle(register).gridTemplateColumns.split(" ").length,
      };
    });
    if (layout.navTop < layout.brandBottom - 2) throw new Error("navigation overlaps the brand row");
    if (layout.scrollWidth > layout.viewport + 1) throw new Error(`horizontal overflow ${layout.scrollWidth}/${layout.viewport}`);
    if (layout.registerColumns !== 2) throw new Error(`archive register has ${layout.registerColumns} mobile columns`);
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
    await page.click(".rail-card");
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
    await page.$eval(".panel", (panel) => { panel.scrollTop = panel.scrollHeight; });
    const reachable = await page.$eval(".panel-close", (button) => {
      const rect = button.getBoundingClientRect();
      return rect.height >= 44 && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === button;
    });
    if (!reachable) throw new Error("the long mobile account lost its close control");
    await page.click(".panel-close");
    if (await page.$(".panel")) throw new Error("mobile profile did not close with a pointer");
  });
  await check("mobile patterns separates insight and timeline", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    const layout = await page.evaluate(() => {
      const heading = document.querySelector(".patterns-map-head").getBoundingClientRect();
      const dossier = document.querySelector(".history-dossier").getBoundingClientRect();
      const scrubber = document.querySelector(".scrubber").getBoundingClientRect();
      return {
        headingBottom: heading.bottom,
        dossierTop: dossier.top,
        dossierBottom: dossier.bottom,
        scrubberTop: scrubber.top,
        scrubberLeft: scrubber.left,
        scrubberRight: scrubber.right,
        viewport: innerWidth,
      };
    });
    if (layout.headingBottom > layout.dossierTop - 8 ||
        layout.dossierBottom > layout.scrubberTop - 12) {
      throw new Error(`patterns panels overlap ${JSON.stringify(layout)}`);
    }
    if (layout.scrubberLeft < 11 || layout.scrubberRight > layout.viewport - 11) {
      throw new Error("timeline is not centered within the viewport");
    }
  });
  await check("compact mobile keeps the dossier above the timeline", async () => {
    await page.setViewport({ width: 390, height: 620 });
    await wait(150);
    const layout = await page.evaluate(() => {
      const dossier = document.querySelector(".history-dossier").getBoundingClientRect();
      const scrubber = document.querySelector(".scrubber").getBoundingClientRect();
      return {
        dossierBottom: dossier.bottom,
        scrubberTop: scrubber.top,
        viewportHeight: innerHeight,
        scrollHeight: document.documentElement.scrollHeight,
      };
    });
    if (layout.dossierBottom > layout.scrubberTop - 8 ||
        layout.scrollHeight > layout.viewportHeight + 1) {
      throw new Error(`compact patterns overlap ${JSON.stringify(layout)}`);
    }
    await page.setViewport({ width: 390, height: 844 });
  });
  await check("small phones and tablets keep routes and controls usable", async () => {
    for (const viewport of [
      { width: 320, height: 568 },
      { width: 768, height: 1024 },
      { width: 1024, height: 768 },
    ]) {
      await page.setViewport(viewport);
      await page.goto(BASE + `/?layout=${viewport.width}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await wait(500);
      await page.$eval("#search", (input) => {
        input.value = "Wally Adam"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await page.click(".rail-card");
      await page.waitForSelector(".panel");
      await wait(1000);
      const profile = await page.evaluate(() => {
        const panel = document.querySelector(".panel").getBoundingClientRect();
        const path = document.querySelector(".explore-route");
        const matrix = path.getScreenCTM();
        const endpoints = [0, path.getTotalLength()].map((length) => (
          path.getPointAtLength(length).matrixTransform(matrix).y
        ));
        return {
          top: panel.top, endpoints, overflow: document.documentElement.scrollWidth > innerWidth,
          scale: Number(document.querySelector(".camera").getAttribute("transform").match(/scale\(([^)]+)\)/)[1]),
        };
      });
      if (profile.overflow || profile.scale <= 4 ||
          (viewport.width <= 820 && profile.endpoints.some((y) => y >= profile.top - 4 || y <= 100))) {
        throw new Error(`profile map is obscured at ${viewport.width}px ${JSON.stringify(profile)}`);
      }
      await page.click("[data-place-step='0']");
      await page.waitForSelector(".selected-place-ring");
      await wait(1000);
      const focusedPlace = await page.evaluate(() => {
        const sheet = document.querySelector(".panel").getBoundingClientRect();
        const ring = document.querySelector(".selected-place-ring");
        const point = new DOMPoint(Number(ring.getAttribute("cx")), Number(ring.getAttribute("cy")))
          .matrixTransform(ring.getScreenCTM());
        return { x: point.x, y: point.y, top: sheet.top, left: sheet.left };
      });
      if (viewport.width <= 820 ? focusedPlace.y >= focusedPlace.top - 8 : focusedPlace.x >= focusedPlace.left - 8) {
        throw new Error(`selected place is obscured at ${viewport.width}px ${JSON.stringify(focusedPlace)}`);
      }
      await page.click(".nav-tab[data-view='patterns']");
      await page.waitForSelector(".scrubber");
      await wait(500);
      const controls = await page.$$eval(".map-tools button, .war-stepper button", (buttons) => buttons.every((button) => {
        const rect = button.getBoundingClientRect();
        return document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === button;
      }));
      if (!controls) throw new Error(`map controls are covered at ${viewport.width}px`);
    }
  });
  await check("small-phone community choices leave a clear way back to results", async () => {
    await page.setViewport({ width: 320, height: 568 });
    await page.goto(BASE + "/?small-filters=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.click(".collection-filters summary");
    await page.click("[data-act='no-groups']");
    await page.click("[data-group='Crestwood Families']");
    await page.click("[data-act='close-filters']");
    const filters = await page.evaluate(() => ({
      open: document.querySelector(".collection-filters").open,
      focused: document.activeElement === document.querySelector(".collection-filters summary"),
      selected: [...document.querySelectorAll("[data-group]:checked")].map((input) => input.dataset.group),
      listHeight: document.querySelector("[data-rail-list]").clientHeight,
      groups: [...document.querySelectorAll(".rail-ghead")].map((heading) => heading.textContent),
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    if (filters.open || !filters.focused || filters.selected.join() !== "Crestwood Families" ||
        filters.listHeight < 80 || filters.groups.length !== 1 || filters.overflow) {
      throw new Error(`small-phone filters obstruct the results ${JSON.stringify(filters)}`);
    }
  });
  await check("reduced motion keeps a readable, still archive", async () => {
    const reduced = await browser.newPage();
    reduced.on("pageerror", (error) => errors.push("reduced motion: " + (error.stack || error.message)));
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
        counters: [...document.querySelectorAll("[data-counter]")].map((counter) => ({
          text: Number(counter.textContent.replace(/,/g, "")),
          target: Number(counter.dataset.counter),
        })),
      };
    });
    await wait(1200);
    const moved = await reduced.evaluate((before) => ({
      belt: getComputedStyle(document.querySelector(".mosaic-track")).transform !== before.belt,
      globe: Number(document.querySelector(".globe-traveler")?.getAttribute("cx")) !== before.traveler,
    }), result);
    await reduced.close();
    if (result.mode !== "reduced" || result.mosaic !== "static") throw new Error("reduced motion was not respected");
    if (result.control) throw new Error("motion control should not render");
    if (result.opacity !== 1 || result.visibility !== "visible") {
      throw new Error("landing content is not immediately visible");
    }
    if (result.counters.some((counter) => counter.text !== counter.target)) {
      throw new Error(`reduced-motion counters are not final ${JSON.stringify(result.counters)}`);
    }
    if (moved.belt || moved.globe) throw new Error("ambient motion continued under reduced motion");
  });
  await check("the archive remains usable without GSAP", async () => {
    const staticPage = await browser.newPage();
    staticPage.on("pageerror", (error) => errors.push("static mode: " + (error.stack || error.message)));
    staticPage.on("console", (message) => { if (message.type() === "error") errors.push("static mode: " + message.text()); });
    await staticPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await staticPage.setRequestInterception(true);
    staticPage.on("request", (request) => {
      if (request.url().includes("/vendor/gsap/")) {
        request.respond({ status: 200, contentType: "application/javascript", body: "" });
      } else request.continue();
    });
    await staticPage.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
    await staticPage.waitForFunction(
      () => document.querySelector(".archive-register, #fatal:not([hidden]), #error:not([hidden])"),
      { timeout: 20000 },
    );
    if (!await staticPage.$(".archive-register")) {
      throw new Error(await staticPage.$eval("#fatal:not([hidden]), #error:not([hidden])", (element) => element.textContent.trim()));
    }
    const fallback = await staticPage.evaluate(() => ({
      mode: document.documentElement.dataset.motion,
      counters: [...document.querySelectorAll("[data-counter]")].map((counter) => ({
        value: Number(counter.textContent.replace(/,/g, "")),
        target: Number(counter.dataset.counter),
      })),
    }));
    await staticPage.click(".nav-tab[data-view='explore']");
    await staticPage.waitForSelector(".rail-card");
    await staticPage.click(".rail-card");
    await staticPage.waitForSelector(".panel");
    await staticPage.close();
    if (fallback.mode !== "static" || fallback.counters.length !== 4 ||
        fallback.counters.some((counter) => counter.value !== counter.target)) {
      throw new Error(`static counter fallback failed ${JSON.stringify(fallback)}`);
    }
  });
  await check("loading failures offer a working retry", async () => {
    const recovery = await browser.newPage();
    recovery.on("pageerror", (error) => errors.push("recovery: " + (error.stack || error.message)));
    await recovery.setViewport({ width: 390, height: 844 });
    await recovery.setRequestInterception(true);
    let failedAsset = null;
    recovery.on("request", (request) => {
      if (failedAsset && request.url().includes(`/data/${failedAsset}`)) {
        request.respond({ status: 503, contentType: "application/json", body: "{}" });
      } else request.continue();
    });
    for (const [asset, cover] of [["survivors.geojson", "#fatal"], ["atlas-world.json", "#error"]]) {
      failedAsset = asset;
      await recovery.goto(BASE + `/?recovery=${asset}`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await recovery.waitForSelector(`${cover}:not([hidden]) .btn`, { timeout: 15000 });
      failedAsset = null;
      await recovery.click(`${cover} .btn`);
      await recovery.waitForSelector(".archive-register", { timeout: 15000 });
      if (await recovery.$(`${cover}:not([hidden])`)) throw new Error(`${asset} retry left the failure visible`);
    }
    await recovery.close();
  });

  await check("historical failures show the current basemap and retry without losing settings", async () => {
    const recovery = await browser.newPage();
    recovery.on("pageerror", (error) => errors.push("historical recovery: " + (error.stack || error.message)));
    await recovery.setRequestInterception(true);
    let fail = true, mode = "503", requests = 0;
    recovery.on("request", (request) => {
      if (!request.url().includes("/data/historical_boundaries.json")) return request.continue();
      requests++;
      if (!fail) return request.continue();
      request.respond({
        status: mode === "503" ? 503 : 200,
        contentType: "application/json",
        headers: { "cache-control": "public, max-age=3600" },
        body: mode === "503" ? "{}" : "{\"type\":\"Topology\",\"objects\":{}}",
      });
    });
    for (const [failure, width, height] of [["503", 390, 844], ["invalid", 320, 568]]) {
      mode = failure; fail = true; requests = 0;
      await recovery.setViewport({ width, height });
      await recovery.goto(BASE + `/?history-recovery=${mode}#/patterns/1960?flags=0&opacity=0.6&compare=1`, {
        waitUntil: "domcontentloaded", timeout: 40000,
      });
      await recovery.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await recovery.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "error");
      const failed = await recovery.evaluate(() => {
        const notice = document.querySelector("[data-boundary-notice]");
        const button = notice.querySelector("button");
        const rect = button.getBoundingClientRect();
        return {
          visible: !notice.hidden,
          message: notice.textContent,
          reachable: document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button") === button,
          misleading: document.querySelectorAll(".modern-countries [data-war-side], .historical-flag").length,
          comparisonVisible: !document.querySelector("[data-compare-caption]").hidden,
          divider: document.querySelector("#map").dataset.comparing,
        };
      });
      if (!failed.visible || !failed.reachable || failed.misleading || failed.comparisonVisible || failed.divider !== "false" ||
          !failed.message.includes("1960 borders could not load") || !failed.message.includes("today's basemap")) {
        throw new Error(`historical failure is hidden or misleading ${JSON.stringify(failed)}`);
      }
      fail = false;
      await recovery.click("[data-act='retry-history']");
      await recovery.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready", { timeout: 20000 });
      const restored = await recovery.evaluate(() => ({
        notice: document.querySelector("[data-boundary-notice]").hidden,
        year: document.querySelector("[data-year-entry]").value,
        flags: document.querySelector("[data-history-setting='flags']").checked,
        opacity: document.querySelector("[data-history-opacity]").value,
        comparison: document.querySelector("[data-history-setting='compare']").checked,
        comparisonVisible: !document.querySelector("[data-compare-caption]").hidden,
        divider: document.querySelector("#map").dataset.comparing,
        borders: document.querySelectorAll(".historical-territory").length,
      }));
      if (!restored.notice || restored.year !== "1960" || restored.flags || restored.opacity !== "0.6" ||
          !restored.comparison || !restored.comparisonVisible || restored.divider !== "true" || !restored.borders || requests !== 2) {
        throw new Error(`retry lost the view or reused bad geometry ${JSON.stringify({ ...restored, requests })}`);
      }
    }
    await recovery.close();
  });

  await check("compact link sharing is readable and dismissible", async () => {
    await page.setViewport({ width: 320, height: 568 });
    await page.goto(BASE + "/?compact-share=1#/patterns/1960?compare=1", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async () => { throw new DOMException("Blocked", "NotAllowedError"); } },
      });
    });
    await page.click("[data-act='share-map']");
    const feedback = await page.$eval(".share-feedback", (element) => {
      const rect = element.getBoundingClientRect();
      const close = element.querySelector(".share-close");
      const button = close.getBoundingClientRect();
      return {
        visible: !element.hidden,
        background: getComputedStyle(element).backgroundColor,
        left: rect.left, right: rect.right, bottom: rect.bottom, height: innerHeight,
        reachable: document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2)?.closest("button") === close,
        link: !element.querySelector("[data-share-address]").hidden,
      };
    });
    if (!feedback.visible || !feedback.link || !feedback.reachable || feedback.background !== "rgb(250, 249, 245)" ||
        feedback.left < 0 || feedback.right > 320 || feedback.bottom > feedback.height) {
      throw new Error(`compact link sharing is obscured ${JSON.stringify(feedback)}`);
    }
    await page.keyboard.press("Escape");
    const closed = await page.evaluate(() => ({
      hidden: document.querySelector(".share-feedback").hidden,
      expanded: document.querySelector("[data-act='share-map']").getAttribute("aria-expanded"),
      focused: document.activeElement.dataset.act,
    }));
    if (!closed.hidden || closed.expanded !== "false" || closed.focused !== "share-map") {
      throw new Error(`sharing could not be dismissed ${JSON.stringify(closed)}`);
    }
  });

  await check("landscape and zoomed layouts keep the collection and reader usable", async () => {
    for (const viewport of [
      { width: 568, height: 320 },
      { width: 667, height: 375 },
      { width: 683, height: 425, deviceScaleFactor: 2 },
    ]) {
      await page.setViewport(viewport);
      await page.goto(BASE + `/?compact-reader=${viewport.width}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const collection = await page.evaluate(() => ({
        presentation: document.querySelector(".ov-explore").dataset.presentation,
        listHeight: document.querySelector("[data-rail-list]").clientHeight,
        mapInert: document.getElementById("map").inert,
        overflow: document.documentElement.scrollWidth > innerWidth,
      }));
      if (collection.presentation !== "reader" || collection.listHeight < 100 || !collection.mapInert || collection.overflow) {
        throw new Error(`compact collection is not usable ${JSON.stringify({ viewport, ...collection })}`);
      }
      await page.type("#search", "Wally Adam");
      await page.click(".rail-card");
      await page.waitForSelector(".panel");
      await wait(650);
      const space = await page.$eval(".panel", (panel) => panel.clientHeight - panel.querySelector(".profile-toolbar").offsetHeight);
      if (space < 160) throw new Error(`only ${space}px of reading space at ${viewport.width}px`);
      await page.click("[data-act='expand-reader']");
      await page.waitForFunction(() => document.querySelector(".ov-explore").dataset.presentation === "map");
      await wait(950);
      if (await page.$eval("#map", (map) => map.inert)) throw new Error("switching to Map left the map disabled");
      const label = await page.$eval(".account-place-marker", (marker) => marker.getAttribute("aria-label"));
      const accessibility = await page.target().createCDPSession();
      const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
      await accessibility.detach();
      if (!nodes.some((node) => !node.ignored && node.role?.value === "button" && node.name?.value === label)) {
        throw new Error("the account map reference is absent from the accessibility tree");
      }
      await page.$eval(".account-place-marker", (marker) => marker.focus());
      await page.keyboard.press("Enter");
      await wait(650);
      const returned = await page.evaluate(() => ({
        presentation: document.querySelector(".ov-explore").dataset.presentation,
        focused: document.activeElement.dataset.placeStep,
        pressed: document.activeElement.getAttribute("aria-pressed"),
        top: document.activeElement.getBoundingClientRect().top,
        toolbar: document.querySelector(".profile-toolbar").getBoundingClientRect().bottom,
      }));
      if (returned.presentation !== "reader" || returned.focused == null || returned.pressed !== "true" ||
          returned.top < returned.toolbar + 8) {
        throw new Error(`a map reference did not open its source entry ${JSON.stringify(returned)}`);
      }
      await page.click(".panel-close");
      if (await page.$eval("#search", (search) => search.value) !== "Wally Adam") {
        throw new Error("closing the compact reader lost the search");
      }
    }
  });
  await check("portrait readers expand without losing the account or scroll position", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(BASE + "/?expand-reader=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    const before = await page.$eval(".panel", (panel) => panel.clientHeight);
    await page.click("[data-act='expand-reader']");
    const expanded = await page.$eval(".panel", (panel) => panel.clientHeight);
    if (expanded < before + 100) throw new Error("Expand did not give the account more reading space");
    await page.click("[data-profile-section='profile-places']");
    await wait(650);
    const top = await page.$eval(".panel", (panel) => panel.scrollTop);
    await page.click("[data-act='expand-reader']");
    const restored = await page.evaluate(() => ({
      mode: document.querySelector(".ov-explore").dataset.presentation,
      name: document.getElementById("profile-name").textContent,
      scroll: document.querySelector(".panel").scrollTop,
      mapInert: document.getElementById("map").inert,
    }));
    if (restored.mode !== "split" || restored.name !== "Wally Adam" || restored.mapInert || Math.abs(restored.scroll - top) > 1) {
      throw new Error(`restoring the map lost the reading position ${JSON.stringify(restored)}`);
    }
  });
  await check("every dated place can be browsed and selection exposes its people", async () => {
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(BASE + "/?history-directory=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.waitForSelector(".pattern-event-marker");
    await page.$eval(".pattern-event-marker", (marker) => marker.focus());
    await page.keyboard.press("Enter");
    await wait(550);
    const selected = await page.evaluate(() => {
      const title = document.getElementById("testimony-place-title");
      const body = document.querySelector("[data-pattern-events]").getBoundingClientRect();
      const rect = title.getBoundingClientRect();
      return {
        open: document.querySelector("[data-history-context]").open,
        focused: document.activeElement.id,
        visible: rect.top >= body.top && rect.bottom <= body.bottom,
      };
    });
    if (!selected.open || selected.focused !== "testimony-place-title" || !selected.visible) {
      throw new Error(`selected testimony is hidden ${JSON.stringify(selected)}`);
    }
    await page.click("[data-act='clear-event']");
    const directory = await page.evaluate(async () => {
      const { loadData } = await import("./js/data.js");
      const store = await loadData();
      const listed = [...document.querySelectorAll("[data-event]")].map((button) => button.dataset.event);
      const expected = store.eventsByYear.get(1944).map((event) => event.key);
      const markers = [...document.querySelectorAll(".pattern-event-marker")].map((marker) => marker.getAttribute("aria-label"));
      const omitted = store.eventsByYear.get(1944).find((event) => !markers.some((label) => label.includes(`${event.year}, ${event.place},`)));
      return { listed, expected, omitted: omitted?.key, open: document.querySelector("[data-history-place-list]").open };
    });
    if (!directory.open || directory.listed.length !== directory.expected.length ||
        directory.expected.some((key) => !directory.listed.includes(key)) || !directory.omitted) {
      throw new Error(`the directory omits dated references ${JSON.stringify(directory)}`);
    }
    await page.evaluate((key) => document.querySelector(`[data-event="${CSS.escape(key)}"]`).focus(), directory.omitted);
    await page.keyboard.press("Enter");
    await wait(550);
    if (!await page.$(".testimony-moment.is-selected")) throw new Error("a lower-ranked place could not be opened");
    await page.$eval("[data-act='next-event']", (button) => button.focus());
    await page.keyboard.press("Enter");
    if (await page.evaluate(() => document.activeElement.dataset.act) !== "next-event") {
      throw new Error("next-place navigation lost keyboard focus");
    }
  });
  await check("dated routes keep positive evidence and exclude other-year or broad references", async () => {
    const sample = await page.evaluate(async () => {
      const { loadData } = await import("./js/data.js");
      const store = await loadData();
      const event = store.events.find((entry) => entry.year >= store.time.min && entry.year <= store.time.max &&
        entry.people.slice(0, 4).some((person) => store.byId.get(person.id).routeWaypoints.filter((place) => place.historyYear === entry.year).length > 1));
      return event && { key: event.key, year: event.year };
    });
    if (!sample) throw new Error("no source-backed positive route case is available for validation");
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + `/?dated-route=1#/patterns/${sample.year}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.click("[data-history-place-list] > summary");
    await page.evaluate((key) => document.querySelector(`[data-event="${CSS.escape(key)}"]`).focus(), sample.key);
    await page.keyboard.press("Enter");
    const routes = await page.$$eval(".selected-testimony-route", (paths) => paths.map((path) => ({
      year: path.__data__.year,
      valid: path.__data__.waypoints.length > 1 && path.__data__.waypoints.every((place) =>
        place.historyYear === path.__data__.year && (place.verified || place.evidenceScope === "personal") &&
        !["country", "region"].includes(place.locationPrecision)),
    })));
    if (!routes.length || routes.some((route) => !route.valid || route.year !== sample.year)) {
      throw new Error(`selected history routes mix date or precision ${JSON.stringify(routes)}`);
    }
  });
  await check("compact history context is a readable sheet with a working return", async () => {
    await page.setViewport({ width: 667, height: 375 });
    await page.goto(BASE + "/?compact-history=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready");
    await page.type("[data-country-search]", "Canada");
    await page.click("[data-history-search] button");
    await wait(450);
    const context = await page.evaluate(() => ({
      height: document.querySelector("[data-pattern-events]").clientHeight,
      name: document.querySelector(".country-heading h3")?.textContent,
      mapInert: document.getElementById("map").inert,
      returnLabel: getComputedStyle(document.querySelector(".context-return")).display,
    }));
    if (context.height < 200 || context.name !== "Canada" || !context.mapInert || context.returnLabel === "none") {
      throw new Error(`compact history context cannot be read ${JSON.stringify(context)}`);
    }
    await page.keyboard.press("Escape");
    await wait(250);
    const returned = await page.evaluate(() => ({
      open: document.querySelector("[data-history-context]").open,
      hidden: document.getElementById("map").inert,
      controls: [...document.querySelectorAll(".history-toolbar > button, .history-toolbar .map-tools button, .history-settings > summary")].every((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width > 0 && document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)?.closest("button, summary") === button;
      }),
    }));
    if (returned.open || returned.hidden || !returned.controls) throw new Error(`return to the map failed ${JSON.stringify(returned)}`);
  });
  await check("broken bookmarks explain the problem and preserve legacy entry links", async () => {
    await page.setViewport({ width: 390, height: 844 });
    for (const route of ["#/survivor/no-such-account", "#/place/no-such-place", "#/unknown-view", "#/patterns/invalid-year"]) {
      await page.goto(BASE + "/?broken-link=1" + route, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const missing = await page.evaluate(() => ({
        view: document.body.dataset.view,
        heading: document.getElementById("missing-title")?.textContent,
        focus: document.activeElement.id,
      }));
      if (missing.view !== "not-found" || !missing.heading?.includes("could not") || missing.focus !== "missing-title") {
        throw new Error(`broken link silently changed pages ${JSON.stringify(missing)}`);
      }
      await page.click(".not-found-content [data-act='explore']");
      await page.waitForSelector(".rail-card");
    }
    for (const legacy of ["#map", "#overlay", "#/guided"]) {
      await page.goto(BASE + "/?legacy-entry=1" + legacy, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      if (await page.evaluate(() => location.hash) !== "#/explore") throw new Error(`legacy entry did not recover: ${legacy}`);
    }
  });

  await check("late historical loading preserves marker focus and open reading controls", async () => {
    for (const target of ["marker", "place-list"]) {
      const delayed = await browser.newPage();
      delayed.on("pageerror", (error) => errors.push("delayed history: " + (error.stack || error.message)));
      await delayed.setViewport({ width: 390, height: 844 });
      await delayed.setCacheEnabled(false);
      await delayed.setRequestInterception(true);
      let boundaryRequest;
      delayed.on("request", (request) => {
        if (request.url().includes("/data/historical_boundaries.json")) boundaryRequest = request;
        else request.continue();
      });
      try {
        await delayed.goto(BASE + `/?delayed-history=${target}#/patterns/1944`, { waitUntil: "domcontentloaded", timeout: 40000 });
        await delayed.waitForSelector("#loading", { hidden: true, timeout: 15000 });
        await delayed.waitForSelector(".pattern-event-marker");
        if (target === "marker") {
          await delayed.$eval(".pattern-event-marker", (element) => element.focus());
        } else {
          await delayed.click("[data-history-context] > summary");
          await delayed.click("[data-history-place-list] > summary");
          await delayed.$eval("[data-event]", (element) => element.focus());
        }
        const before = await delayed.evaluate(() => ({
          map: document.activeElement.dataset.mapFocus,
          event: document.activeElement.dataset.event,
        }));
        if (!boundaryRequest) throw new Error("historical loading was not intercepted");
        await boundaryRequest.continue();
        await delayed.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready", { timeout: 20000 });
        const after = await delayed.evaluate(() => ({
          map: document.activeElement.dataset.mapFocus,
          event: document.activeElement.dataset.event,
          open: document.querySelector("[data-history-place-list]").open,
        }));
        if (target === "marker" ? !before.map || after.map !== before.map : !before.event || after.event !== before.event || !after.open) {
          throw new Error(`loading discarded ${target} focus ${JSON.stringify({ before, after })}`);
        }
        await delayed.keyboard.press("Enter");
        await delayed.waitForSelector("#testimony-place-title");
        if (await delayed.evaluate(() => document.activeElement.id) !== "testimony-place-title") {
          throw new Error("the preserved control did not activate its testimony");
        }
      } finally {
        await delayed.close();
      }
    }
  });

  await check("collection searches and communities survive reloads and account links", async () => {
    for (const viewport of [{ width: 1366, height: 850 }, { width: 390, height: 844 }]) {
      await page.setViewport(viewport);
      await page.goto(BASE + `/?collection-address=${viewport.width}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await page.click(".collection-filters > summary");
      await page.click("[data-act='no-groups']");
      await page.click("[data-group='Military Veterans']");
      await page.click(".collection-filters > summary");
      await page.type("#search", "Wally Adam");
      const address = await page.evaluate(() => location.hash);
      const params = new URLSearchParams(address.split("?")[1]);
      if (params.get("q") !== "Wally Adam" || params.get("groups") !== "military-veterans") {
        throw new Error(`the collection address omits its filters ${address}`);
      }
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const restored = await page.evaluate(() => ({
        query: document.querySelector("#search").value,
        groups: [...document.querySelectorAll("[data-group]:checked")].map((input) => input.dataset.group),
        count: document.querySelector("[data-rail-count]").textContent,
        filtersOpen: document.querySelector(".collection-filters").open,
        title: document.title,
      }));
      if (restored.query !== "Wally Adam" || restored.groups.join() !== "Military Veterans" ||
          restored.count !== "1 of 1 shown" || restored.filtersOpen || !restored.title.includes("Wally Adam")) {
        throw new Error(`reload lost the collection context ${JSON.stringify(restored)}`);
      }
      await page.click(".rail-card");
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      if (!await page.$eval("#profile-name", (heading) => document.title.includes(heading.textContent))) {
        throw new Error("the account's tab title is not identifiable");
      }
      await page.click(".panel-close");
      if (await page.$eval("[data-rail-count]", (count) => count.textContent) !== "1 of 1 shown") {
        throw new Error("the account link lost its collection context after reload");
      }
    }
  });
  await check("empty community selections and loaded result counts are bookmarkable", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?result-address=1#/explore?groups=", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    if (await page.$(".rail-card") || await page.$$eval("[data-group]:checked", (inputs) => inputs.length)) {
      throw new Error("an explicit empty community selection became all communities");
    }
    await page.click(".filter-reset");
    await page.click("[data-act='more']");
    const more = await page.evaluate(() => ({
      hash: location.hash, cards: document.querySelectorAll(".rail-card").length,
      next: document.activeElement.dataset.survivor,
    }));
    if (!more.next || more.cards !== 420 || new URLSearchParams(more.hash.split("?")[1]).get("limit") !== "420") {
      throw new Error(`loading more results did not update the bookmark ${JSON.stringify(more)}`);
    }
    await page.keyboard.press("Enter");
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.click(".panel-close");
    const returned = await page.evaluate(() => {
      const list = document.querySelector("[data-rail-list]").getBoundingClientRect();
      const card = document.activeElement.getBoundingClientRect();
      return {
        cards: document.querySelectorAll(".rail-card").length,
        id: document.activeElement.dataset.survivor,
        visible: card.top >= list.top - 1 && card.bottom <= list.bottom + 1,
      };
    });
    if (returned.cards !== 420 || returned.id !== more.next || !returned.visible) {
      throw new Error(`the bookmarked account lost its loaded browse position ${JSON.stringify(returned)}`);
    }
  });
  await check("selected historical places survive back navigation, sharing and layer changes", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?selected-history=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready");
    await page.$eval(".pattern-event-marker", (marker) => marker.focus());
    await page.keyboard.press("Enter");
    await wait(1000);
    await page.click("[data-act='zoom-in']");
    await wait(450);
    const before = await page.evaluate(() => ({
      key: new URLSearchParams(location.hash.split("?")[1]).get("event"),
      place: document.getElementById("testimony-place-title").textContent,
      scale: Number(document.querySelector(".camera").getAttribute("transform").match(/scale\(([^)]+)\)/)[1]),
    }));
    if (!before.key) throw new Error("the selected dated place is absent from the address");
    await page.click(".history-settings > summary");
    await page.click("[data-history-setting='labels']");
    await page.keyboard.press("Escape");
    await wait(450);
    const scale = await page.$eval(".camera", (camera) => Number(camera.getAttribute("transform").match(/scale\(([^)]+)\)/)[1]));
    if (Math.abs(scale - before.scale) > .01) throw new Error("changing a layer reset the selected-place camera");
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (link) => { window.__selectedHistoryLink = link; } },
      });
    });
    await page.click("[data-act='share-map']");
    const link = await page.evaluate(() => window.__selectedHistoryLink);
    if (new URLSearchParams(new URL(link).hash.split("?")[1]).get("event") !== before.key) {
      throw new Error("the copied map omits the selected dated place");
    }
    await page.click("[data-act='close-share']");
    await page.click(".testimony-moment .event-person");
    await page.goBack();
    await page.waitForSelector("#testimony-place-title");
    await wait(1000);
    const back = await page.evaluate(() => ({
      place: document.getElementById("testimony-place-title").textContent,
      focused: document.activeElement.id,
      scale: Number(document.querySelector(".camera").getAttribute("transform").match(/scale\(([^)]+)\)/)[1]),
    }));
    if (back.place !== before.place || back.focused !== "testimony-place-title" || Math.abs(back.scale - before.scale) > .01) {
      throw new Error(`Back lost the historical context ${JSON.stringify(back)}`);
    }
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(link, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready");
    await wait(1100);
    const shared = await page.evaluate(() => ({
      place: document.getElementById("testimony-place-title")?.textContent,
      open: document.querySelector("[data-history-context]").open,
      focused: document.activeElement.id,
      title: document.title,
      labels: document.querySelector("[data-history-setting='labels']").checked,
      scale: Number(document.querySelector(".camera").getAttribute("transform").match(/scale\(([^)]+)\)/)[1]),
    }));
    if (shared.place !== before.place || !shared.open || shared.focused !== "testimony-place-title" ||
        shared.labels || !shared.title.includes(before.place) || !shared.title.includes("1944") ||
        Math.abs(shared.scale - before.scale) > .01) {
      throw new Error(`the shared dated place did not restore ${JSON.stringify(shared)}`);
    }
    await page.setViewport({ width: 1366, height: 850 });
    await wait(350);
    await page.setViewport({ width: 390, height: 844 });
    await wait(1100);
    const focusedTitleVisible = await page.evaluate(() => {
      const title = document.getElementById("testimony-place-title").getBoundingClientRect();
      const body = document.querySelector("[data-pattern-events]").getBoundingClientRect();
      return title.top >= body.top && title.bottom <= body.bottom;
    });
    if (!focusedTitleVisible) throw new Error("resizing hid the selected place behind the context heading");
  });
  await check("a new recorded-place search clears the previous dated selection", async () => {
    await page.click("[data-country-search]");
    await page.type("[data-country-search]", "Toronto, Canada");
    await page.click("[data-history-search] button");
    const searched = await page.evaluate(() => ({
      event: new URLSearchParams(location.hash.split("?")[1]).get("event"),
      selected: Boolean(document.getElementById("testimony-place-title")),
      title: document.title,
    }));
    if (searched.event || searched.selected || !searched.title.includes("Toronto, Canada")) {
      throw new Error(`a new map search retained unrelated testimony ${JSON.stringify(searched)}`);
    }
  });
  await check("invalid saved filters and mismatched dated places do not silently change context", async () => {
    for (const hash of [
      "#/explore?groups=unrecognized-community",
      "#/survivor/adam-wally?limit=not-a-number",
      "#/patterns/1945?event=1944%7Ctransit%7CEngland",
      "#/patterns/1944?event=missing-place",
      "#/patterns/1944?event=1944%7Ctransit%7CEngland&testimony=0",
    ]) {
      await page.goto(BASE + "/?invalid-view=1" + hash, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      if (!await page.$("#missing-title")) throw new Error(`an invalid address silently changed state: ${hash}`);
    }
    const query = "Name? A&B";
    const params = new URLSearchParams({ q: query, groups: "military-veterans" });
    await page.goto(BASE + `/?encoded-query=1#/explore?${params}`, { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    if (await page.$eval("#search", (search) => search.value) !== query) {
      throw new Error("the saved query lost its punctuation");
    }
  });

  await check("temporary archive interruptions recover once with visible status", async () => {
    // The recovery leg is deterministic; other scenarios exercise the live archive.
    const archive = fs.readFileSync(path.join(__dirname, "..", "data", "survivors.geojson"), "utf8");
    const recovery = await browser.newPage();
    recovery.on("pageerror", (error) => errors.push("archive retry: " + error.message));
    await recovery.setViewport({ width: 390, height: 844 });
    await recovery.setRequestInterception(true);
    let mode = "http", requests = 0;
    recovery.on("request", (request) => {
      if (!request.url().includes("/data/survivors.geojson")) return request.continue();
      requests++;
      if (requests === 1 && mode === "network") return request.abort("connectionfailed");
      if (requests === 1 || mode === "persistent") {
        return request.respond({ status: 503, contentType: "application/json", body: "{}" });
      }
      request.respond({ status: 200, contentType: "application/json", body: archive });
    });
    try {
      for (const failure of ["http", "network", "persistent"]) {
        mode = failure; requests = 0;
        await recovery.goto(BASE + `/?archive-interruption=${mode}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
        await recovery.waitForFunction(() => document.querySelector(".loading-status")?.textContent === "Reconnecting to the archive", { timeout: 15000 });
        if (mode === "persistent") {
          await recovery.waitForSelector("#fatal:not([hidden])");
          if (requests !== 2 || await recovery.$(".rail-card")) throw new Error("a persistent archive failure was hidden or retried indefinitely");
        } else {
          await recovery.waitForFunction(() => document.querySelector(".rail-card") || !document.getElementById("fatal").hidden, { timeout: 20000 });
          if (requests !== 2 || !await recovery.$eval("#fatal", (fatal) => fatal.hidden)) {
            throw new Error(`the ${mode} interruption did not recover with exactly one retry`);
          }
        }
      }
    } finally {
      await recovery.close();
    }
  });

  await check("live reduced-motion changes settle counters and pause ambient motion", async () => {
    const liveMotion = await browser.newPage();
    liveMotion.on("pageerror", (error) => errors.push("live motion: " + error.message));
    await liveMotion.setViewport({ width: 390, height: 844 });
    await liveMotion.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    try {
      await liveMotion.goto(BASE + "/?live-motion=1", { waitUntil: "domcontentloaded", timeout: 40000 });
      await liveMotion.waitForSelector("[data-counter]", { timeout: 15000 });
      await liveMotion.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await liveMotion.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
      await liveMotion.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const capture = () => liveMotion.evaluate(() => ({
        counters: [...document.querySelectorAll("[data-counter]")].map((counter) => ({
          value: Number(counter.textContent.replace(/,/g, "")), target: Number(counter.dataset.counter),
        })),
        belt: getComputedStyle(document.querySelector(".mosaic-track")).transform,
        globe: document.querySelector(".globe-graticule").getAttribute("d"),
        mode: document.documentElement.dataset.motion,
        mosaic: document.documentElement.dataset.mosaicMotion,
        visible: [...document.querySelectorAll(".landing-card > *")].every((element) =>
          getComputedStyle(element).visibility !== "hidden" && Number(getComputedStyle(element).opacity) > 0),
      }));
      const reduced = await capture();
      await wait(750);
      const still = await capture();
      if (reduced.mode !== "reduced" || reduced.mosaic !== "static" || !reduced.visible ||
          reduced.counters.some((counter) => counter.value !== counter.target) ||
          still.belt !== reduced.belt || still.globe !== reduced.globe) {
        throw new Error("the live reduced-motion setting left moving or incomplete content");
      }
      await liveMotion.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await liveMotion.waitForFunction(() => document.documentElement.dataset.mosaicMotion === "animated");
      await wait(500);
      const resumed = await capture();
      if (resumed.belt === still.belt || resumed.globe === still.globe ||
          resumed.counters.some((counter) => counter.value !== counter.target)) {
        throw new Error("restoring motion failed or replayed the completed counters");
      }
      await liveMotion.waitForFunction(() => [...document.querySelectorAll(".mosaic-tile")]
        .some((tile) => Number(tile.dataset.swapCount) > 0), { timeout: 5000 });
      await liveMotion.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await liveMotion.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
      const facesVisible = await liveMotion.$$eval(".mosaic-tile", (tiles) => tiles.every((tile) =>
        [...tile.querySelectorAll(".mosaic-side")].some((side) => {
          const style = getComputedStyle(side);
          return style.visibility !== "hidden" && Number(style.opacity) >= .99;
        })));
      if (!facesVisible) throw new Error("reducing motion during a portrait change left a faded or hidden photograph");
    } finally {
      await liveMotion.close();
    }
  });
  await check("motion changes finish active routes and cameras and pause history playback", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await page.goto(BASE + "/?motion-state=1#/explore?q=Wally+Adam", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.click(".rail-card");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
    const stopped = await page.evaluate(() => ({
      name: document.getElementById("profile-name").textContent,
      offset: Number(document.querySelector(".explore-route").getAttribute("stroke-dashoffset") || 0),
      camera: document.querySelector(".camera").getAttribute("transform"),
    }));
    await wait(1000);
    if (stopped.name !== "Wally Adam" || stopped.offset !== 0 ||
        await page.$eval(".camera", (camera) => camera.getAttribute("transform")) !== stopped.camera) {
      throw new Error("reducing motion left an incomplete route or moving camera");
    }
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    const before = await page.$eval(".camera", (camera) => Number(camera.getAttribute("transform").match(/scale\(([^)]+)\)/)[1]));
    await page.click("[data-act='zoom-out']");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.waitForFunction(() => document.documentElement.dataset.motion === "reduced");
    const zoom = await page.$eval(".camera", (camera) => Number(camera.getAttribute("transform").match(/scale\(([^)]+)\)/)[1]));
    if (Math.abs(zoom - Math.max(1, before / 1.5)) > .01) throw new Error("motion change abandoned the intended zoom target");
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector("[data-year-entry]");
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await page.click("[data-act='play-history']");
    const year = await page.$eval("[data-year-entry]", (input) => Number(input.value));
    await page.waitForFunction((previous) => Number(document.querySelector("[data-year-entry]").value) > previous, { timeout: 5000 }, year);
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    const paused = await page.$eval("[data-year-entry]", (input) => input.value);
    await wait(1400);
    if (await page.$eval("[data-year-entry]", (input) => input.value) !== paused ||
        await page.$eval("[data-act='play-history']", (button) => button.getAttribute("aria-pressed")) !== "false") {
      throw new Error("changing the motion preference did not pause history playback");
    }
  });

  for (const transfer of dataTransfers.values()) {
    if (transfer.failed < 0) continue;
    if (transfer.completed <= transfer.failed) errors.push(`unrecovered data request: ${transfer.url} (${transfer.reasons.join(", ")})`);
    else console.log(`RECOVERED data request: ${transfer.url} (${transfer.reasons.join(", ")})`);
  }
  await browser.close();
  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
