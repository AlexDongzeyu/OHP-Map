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
  const coreData = (url) => /\/data\/(?:index\.json|survivors\.geojson|place_index\.json|connections\.json|war_context\.json|historical_boundary_index\.json|profiles\/[^/]+\.json)(?:\?|$)/.test(url || "");
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
      const response = await fetch("/data/survivors.geojson");
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
  await check("compact startup defers complete profile details until an account opens", async () => {
    const compactContext = await browser.createBrowserContext();
    const compactPage = await compactContext.newPage();
    await compactPage.setCacheEnabled(false);
    compactPage.on("pageerror", (error) => errors.push("compact startup: " + error.message));
    const requests = [];
    compactPage.on("request", (request) => { requests.push(new URL(request.url()).pathname); });
    try {
      await compactPage.goto(BASE + "/?compact-delivery=1", { waitUntil: "domcontentloaded", timeout: 40000 });
      await compactPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const startup = await compactPage.evaluate(() => {
        const data = performance.getEntriesByType("resource").find((entry) => entry.name.includes("/data/index.json"));
        return { bytes: data?.decodedBodySize, transferred: data?.transferSize, readyMs: Math.round(performance.now()) };
      });
      if (!requests.includes("/data/index.json") || requests.includes("/data/survivors.geojson") ||
          requests.some((url) => url.startsWith("/data/profiles/")) || !startup.bytes || startup.bytes > 3_000_000) {
        throw new Error(`startup did not use the compact index ${JSON.stringify({ startup, requests: requests.filter(url => url.startsWith("/data/")) })}`);
      }
      await compactPage.click(".nav-tab[data-view='explore']");
      await compactPage.$eval("#search", input => {
        input.value = "Martin Baranek"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await compactPage.click(".rail-card");
      await compactPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      const details = requests.filter((url) => url.startsWith("/data/profiles/"));
      if (details.length !== 1 || !details[0].includes("/baranek-martin.") ||
          !await compactPage.$eval(".bio", bio => bio.textContent.length > 100)) {
        throw new Error(`the selected account was not loaded independently ${JSON.stringify(details)}`);
      }
      console.log(`MEASURE compact startup: ${startup.bytes} decoded bytes; ${startup.transferred} transferred; ${startup.readyMs} ms`);
    } finally {
      await compactContext.close();
    }
  });
  await check("immutable release assets and compatible response headers are published", async () => {
    const response = await fetch(BASE + "/");
    const html = await response.text();
    const release = html.match(/name="ohp-static-release" content="([a-f0-9]{64})"/)?.[1];
    if (!release || response.headers.get("x-content-type-options") !== "nosniff" ||
        response.headers.get("referrer-policy") !== "strict-origin-when-cross-origin" ||
        !response.headers.get("content-security-policy")?.includes("frame-ancestors")) {
      throw new Error("the static release or compatible security headers are missing");
    }
    const versioned = await fetch(`${BASE}/releases/${release}/js/app.js`);
    const alias = await fetch(BASE + "/js/app.js");
    if (!versioned.ok || !alias.ok ||
        !versioned.headers.get("cache-control")?.includes("max-age=31536000, immutable") ||
        alias.headers.get("cache-control")?.includes("immutable") ||
        await versioned.text() !== await alias.text()) {
      throw new Error("static asset aliases and immutable releases do not agree");
    }
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
      needsReview: [...document.querySelectorAll(".reference-kind")].filter((element) => element.textContent === "Needs review").length,
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
      markers: document.querySelectorAll("#map .place-cluster").length,
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
        backgroundPeople: document.querySelectorAll("#map .place-cluster").length,
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
    await page.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
    const unmapped = await page.evaluate(() => ({
      notice: document.querySelector(".profile-route-status").textContent,
      noticeTop: document.querySelector(".profile-route-status").getBoundingClientRect().top,
      sourceTop: document.querySelector(".profile-actions").getBoundingClientRect().top,
      drawn: document.querySelectorAll("#map .explore-route, #map .account-place-marker, #map .place-cluster").length,
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
    await wait(1000);
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
    if (fitted !== before) throw new Error(`fit map did not restore the data extent (${before} -> ${fitted})`);
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
        !decolonization.map?.endsWith("/assets/history/atlas-1960.svg") ||
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
        markers: [...new Set([...document.querySelectorAll("#map .place-cluster")]
          .flatMap((marker) => JSON.parse(marker.dataset.accountIds)))],
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
      if (profile.overflow || profile.scale < 1 ||
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
  await check("reduced interface motion keeps content readable while the landing plays", async () => {
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
        control: Boolean(document.querySelector("#motion-toggle, .landing-motion, [data-act='toggle-landing-motion']")),
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
    if (result.mode !== "reduced" || result.mosaic !== "animated") throw new Error("landing and interface motion states are incorrect");
    if (result.control) throw new Error("motion control should not render");
    if (result.opacity !== 1 || result.visibility !== "visible") {
      throw new Error("landing content is not immediately visible");
    }
    if (result.counters.some((counter) => counter.text !== counter.target)) {
      throw new Error(`reduced-motion counters are not final ${JSON.stringify(result.counters)}`);
    }
    if (!moved.belt || !moved.globe) throw new Error("the landing background did not play automatically");
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
    for (const [asset, cover] of [["index.json", "#fatal"], ["atlas-world.json", "#error"]]) {
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
    const archive = fs.readFileSync(path.join(__dirname, "..", "public", "data", "index.json"), "utf8");
    const recovery = await browser.newPage();
    recovery.on("pageerror", (error) => errors.push("archive retry: " + error.message));
    await recovery.setViewport({ width: 390, height: 844 });
    await recovery.setRequestInterception(true);
    let mode = "http", requests = 0;
    recovery.on("request", (request) => {
      if (!request.url().includes("/data/index.json")) return request.continue();
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

  await check("live reduced-motion changes settle counters without stopping the landing", async () => {
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
      const moving = await capture();
      if (reduced.mode !== "reduced" || reduced.mosaic !== "animated" || !reduced.visible ||
          reduced.counters.some((counter) => counter.value !== counter.target) ||
          moving.belt === reduced.belt || moving.globe === reduced.globe) {
        throw new Error("the motion preference interrupted the background or left incomplete counters");
      }
      await liveMotion.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
      await liveMotion.waitForFunction(() => document.documentElement.dataset.mosaicMotion === "animated");
      await wait(500);
      const resumed = await capture();
      if (resumed.belt === moving.belt || resumed.globe === moving.globe ||
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
          return style.visibility !== "hidden" && Number(style.opacity) > .1;
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

  await check("saved accounts persist locally, filter the map and synchronize across tabs", async () => {
    const context = await browser.createBrowserContext();
    const savedPage = await context.newPage();
    savedPage.on("pageerror", (error) => errors.push("saved accounts: " + error.message));
    try {
      await savedPage.setViewport({ width: 1366, height: 850 });
      await savedPage.goto(BASE + "/?saved-tools=1#/explore?q=Wally+Adam", { waitUntil: "domcontentloaded", timeout: 40000 });
      await savedPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await savedPage.click(".rail-save");
      const firstSave = await savedPage.evaluate(() => ({
        saved: JSON.parse(localStorage.getItem("ohp-map.saved-accounts.v1")),
        panel: Boolean(document.querySelector(".panel")),
        pressed: document.querySelector(".rail-save").getAttribute("aria-pressed"),
      }));
      if (firstSave.panel || firstSave.pressed !== "true" || firstSave.saved.ids.join() !== "adam-wally") {
        throw new Error(`saving opened a profile or did not persist ${JSON.stringify(firstSave)}`);
      }
      await savedPage.$eval("#search", (input) => {
        input.value = "Norman Baker"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await savedPage.click(".rail-save");
      await savedPage.click(".saved-view");
      const saved = await savedPage.evaluate(() => ({
        ids: [...document.querySelectorAll(".rail-card")].map((card) => card.dataset.survivor),
        markers: [...new Set([...document.querySelectorAll("#map .place-cluster")]
          .flatMap((marker) => JSON.parse(marker.dataset.accountIds)))],
        count: document.querySelector("[data-rail-count]").textContent,
        privacy: document.querySelector("[data-saved-privacy]").innerText,
      }));
      if (saved.ids.join() !== "adam-wally,baker-norman" || saved.markers.sort().join() !== "adam-wally,baker-norman" ||
          saved.count !== "2 of 2 shown" || !saved.privacy.includes("only in this browser")) {
        throw new Error(`saved filtering is not exact or private ${JSON.stringify(saved)}`);
      }
      await savedPage.click(".rail-card");
      await savedPage.click(".result-navigation:not(.result-navigation-end) [data-act='next-account']");
      if (await savedPage.$eval("#profile-name", (heading) => heading.textContent) !== "Norman Baker") {
        throw new Error("Next did not stay within saved results");
      }
      if (!await savedPage.$eval(".result-navigation [data-act='next-account']", (button) => button.disabled)) {
        throw new Error("the final saved result did not disable Next");
      }
      await savedPage.click(".panel-close");
      const secondTab = await context.newPage();
      await secondTab.goto(BASE + "/?saved-second-tab=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await secondTab.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await secondTab.click(".account-save");
      await savedPage.bringToFront();
      await savedPage.waitForFunction(() => document.querySelector("[data-rail-count]").textContent === "1 of 1 shown");
      await savedPage.reload({ waitUntil: "domcontentloaded" });
      await savedPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const reloaded = await savedPage.$$eval(".rail-card", (cards) => cards.map((card) => card.dataset.survivor));
      if (reloaded.join() !== "baker-norman") throw new Error("saved changes did not survive reload");
      savedPage.once("dialog", (dialog) => dialog.dismiss());
      await savedPage.click("[data-act='reset-saved-list']");
      if (!await savedPage.$(".rail-card")) throw new Error("cancelling Clear saved list removed accounts");
      savedPage.once("dialog", (dialog) => dialog.accept());
      await savedPage.click("[data-act='reset-saved-list']");
      if (await savedPage.$(".rail-card") || !await savedPage.$eval(".rail-empty", (empty) => empty.innerText.includes("Keep an account for later"))) {
        throw new Error("clearing the saved list did not show a useful empty state");
      }
    } finally {
      await context.close();
    }
  });
  await check("storage failures preserve existing data and never claim a successful save", async () => {
    for (const mode of ["blocked", "corrupt"]) {
      const context = await browser.createBrowserContext();
      const storagePage = await context.newPage();
      storagePage.on("pageerror", (error) => errors.push("storage recovery: " + error.message));
      try {
        await storagePage.evaluateOnNewDocument((mode) => {
          if (mode === "corrupt") localStorage.setItem("ohp-map.saved-accounts.v1", '{"version":2,"ids":["adam-wally"]}');
          else {
            const original = Storage.prototype.setItem;
            Storage.prototype.setItem = function (key, value) {
              if (key === "ohp-map.saved-accounts.v1") throw new DOMException("Denied", "QuotaExceededError");
              return original.call(this, key, value);
            };
          }
        }, mode);
        await storagePage.goto(BASE + `/?storage-tools=${mode}#/survivor/adam-wally`, { waitUntil: "domcontentloaded", timeout: 40000 });
        await storagePage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
        await storagePage.click(".account-save");
        const result = await storagePage.evaluate(() => ({
          saved: document.querySelector(".account-save").getAttribute("aria-pressed"),
          error: document.querySelector("[data-account-saved-feedback]").textContent,
          stored: localStorage.getItem("ohp-map.saved-accounts.v1"),
        }));
        if (result.saved !== "false" || !result.error.includes("could not be changed") ||
            (mode === "corrupt" ? JSON.parse(result.stored).version !== 2 : result.stored !== null)) {
          throw new Error(`storage failure was hidden or overwrote data ${JSON.stringify(result)}`);
        }
        await storagePage.click(".panel-close");
        await storagePage.click(".saved-view");
        if (mode === "corrupt") {
          storagePage.once("dialog", (dialog) => dialog.accept());
          await storagePage.click("[data-act='reset-saved-list']");
          if (await storagePage.evaluate(() => localStorage.getItem("ohp-map.saved-accounts.v1")) !== null) {
            throw new Error("explicit reset did not recover a damaged list");
          }
        }
      } finally {
        await context.close();
      }
    }
  });
  await check("account links and source citations are selectable and copy without private filters", async () => {
    const referencePage = await browser.newPage();
    referencePage.on("pageerror", (error) => errors.push("account references: " + error.message));
    try {
      await referencePage.setViewport({ width: 390, height: 844 });
      await referencePage.goto(BASE + "/?reference-tools=1#/survivor/adam-wally?q=Private+query&groups=military-veterans&saved=1", {
        waitUntil: "domcontentloaded", timeout: 40000,
      });
      await referencePage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await referencePage.evaluate(() => {
        window.__accountCopies = [];
        Object.defineProperty(navigator, "clipboard", { configurable: true,
          value: { writeText: async (text) => window.__accountCopies.push(text) } });
      });
      await referencePage.click("[data-act='toggle-account-reference']");
      await wait(650);
      await referencePage.click("[data-copy-account='link']");
      const link = await referencePage.evaluate(() => window.__accountCopies[0]);
      if (link !== new URL("/survivor/adam-wally", BASE).href || /private|saved=|reference-tools/i.test(link)) {
        throw new Error(`account sharing leaked local filters ${link}`);
      }
      await referencePage.click("[data-copy-account='citation']");
      const reference = await referencePage.evaluate(() => ({
        citation: document.getElementById("account-citation").value,
        copies: window.__accountCopies,
        source: document.querySelector(".archive-pill").href,
      }));
      if (reference.copies[1] !== reference.citation || !reference.citation.includes(reference.source) ||
          !reference.citation.includes('"Wally Adam."') || !reference.citation.includes("Accessed ")) {
        throw new Error(`the source citation is incomplete ${JSON.stringify(reference)}`);
      }
      await referencePage.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true,
          value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } });
      });
      await referencePage.click("[data-copy-account='citation']");
      const blocked = await referencePage.$eval("#account-citation", (field) => ({
        focused: document.activeElement === field,
        selected: field.selectionStart === 0 && field.selectionEnd === field.value.length,
        status: document.querySelector("[data-account-copy-status]").textContent,
        expanded: document.querySelector("[data-act='toggle-account-reference']").getAttribute("aria-expanded"),
      }));
      if (!blocked.focused || !blocked.selected || !blocked.status.includes("selected for you") || blocked.expanded !== "true") {
        throw new Error(`blocked clipboard has no usable fallback ${JSON.stringify(blocked)}`);
      }
      await referencePage.keyboard.press("Escape");
      const closed = await referencePage.evaluate(() => ({
        hidden: document.getElementById("account-reference").hidden,
        name: document.getElementById("profile-name").textContent,
        focus: document.activeElement.dataset.act,
      }));
      if (!closed.hidden || closed.name !== "Wally Adam" || closed.focus !== "toggle-account-reference") {
        throw new Error(`closing reference tools lost the account ${JSON.stringify(closed)}`);
      }
    } finally {
      await referencePage.close();
    }
  });
  await check("reader navigation follows stable results beyond the loaded page", async () => {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?reader-order=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    const expected = await page.evaluate(async () => {
      const { loadData, collectionResults } = await import("./js/data.js");
      const store = await loadData();
      return collectionResults(store, { groupFilter: new Set(store.groups.map((group) => group.name)) }).map((journey) => journey.id);
    });
    const visible = await page.$$eval(".rail-card", (cards) => cards.map((card) => card.dataset.survivor));
    if (visible.join() !== expected.slice(0, 140).join()) throw new Error("the reader and collection disagree on result order");
    await page.click(".rail-card");
    if (!await page.$eval(".result-navigation [data-act='previous-account']", (button) => button.disabled)) {
      throw new Error("the first account has an enabled Previous control");
    }
    await page.click(".result-navigation:not(.result-navigation-end) [data-act='next-account']");
    if (await page.evaluate(() => location.hash.split("?")[0]) !== `#/survivor/${expected[1]}`) throw new Error("Next skipped a result");
    await page.click(".panel-close");
    await page.evaluate((id) => document.querySelector(`[data-survivor="${CSS.escape(id)}"]`).focus(), expected[139]);
    await page.keyboard.press("Enter");
    await page.click(".result-navigation:not(.result-navigation-end) [data-act='next-account']");
    const paged = await page.evaluate(() => ({
      hash: location.hash.split("?")[0],
      count: document.querySelectorAll(".rail-card").length,
      focus: document.activeElement.id,
    }));
    if (paged.hash !== `#/survivor/${expected[140]}` || paged.count < 141 || paged.focus !== "profile-name") {
      throw new Error(`continuing beyond the first page lost the results ${JSON.stringify(paged)}`);
    }
    await page.click(".result-navigation:not(.result-navigation-end) [data-act='previous-account']");
    if (await page.evaluate(() => location.hash.split("?")[0]) !== `#/survivor/${expected[139]}`) throw new Error("Previous did not return to the same result");
  });
  await check("saving and opening reference tools do not restart a playing interview", async () => {
    const context = await browser.createBrowserContext();
    const mediaPage = await context.newPage();
    mediaPage.on("pageerror", (error) => errors.push("reader tools media: " + error.message));
    await mediaPage.setRequestInterception(true);
    mediaPage.on("request", (request) => request.url().startsWith("https://player.vimeo.com/video/")
      ? request.respond({ status: 200, contentType: "text/html", body: "<html><body>Player test</body></html>" })
      : request.continue());
    try {
      await mediaPage.setViewport({ width: 1366, height: 850 });
      await mediaPage.goto(BASE + "/?media-tools=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await mediaPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await mediaPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await mediaPage.click("[data-act='show-interviews']");
      await wait(600);
      await mediaPage.click(".video-chapter[data-video]");
      await mediaPage.waitForSelector(".player-frame iframe");
      await mediaPage.$eval(".player-frame iframe", (frame) => { frame.dataset.continuous = "yes"; });
      await mediaPage.click(".account-save");
      await mediaPage.click("[data-act='toggle-account-reference']");
      if (await mediaPage.$eval(".player-frame iframe", (frame) => frame.dataset.continuous) !== "yes") {
        throw new Error("reference or save tools replaced the playing iframe");
      }
    } finally {
      await context.close();
    }
  });
  await check("research tools remain accessible on small phones and landscape readers", async () => {
    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      await page.setViewport(viewport);
      await page.goto(BASE + `/?research-layout=${viewport.width}#/explore?q=Wally+Adam`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await page.click(".rail-save");
      await page.click(".saved-view");
      await page.click(".rail-card");
      await page.click("[data-act='toggle-account-reference']");
      await wait(650);
      const layout = await page.evaluate(() => {
        const field = document.getElementById("account-link").getBoundingClientRect();
        const panel = document.querySelector(".panel").getBoundingClientRect();
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          fieldLeft: field.left, fieldRight: field.right, panelLeft: panel.left, panelRight: panel.right,
          copyHeight: document.querySelector("[data-copy-account='link']").getBoundingClientRect().height,
          savedHeight: document.querySelector(".account-save").getBoundingClientRect().height,
        };
      });
      if (layout.overflow || layout.fieldLeft < layout.panelLeft || layout.fieldRight > layout.panelRight ||
          layout.copyHeight < 44 || layout.savedHeight < 44) {
        throw new Error(`research controls overflow or are too small ${JSON.stringify({ viewport, ...layout })}`);
      }
      await page.click("[data-act='close-account-reference']");
      await page.click(".account-save");
      const removed = await page.evaluate(() => ({
        saved: document.querySelector(".account-save").getAttribute("aria-pressed"),
        ids: JSON.parse(localStorage.getItem("ohp-map.saved-accounts.v1")).ids,
        hash: location.hash,
      }));
      if (removed.saved !== "false") throw new Error(`closing citation tools left Save covered ${JSON.stringify({ viewport, removed })}`);
      await page.click(".panel-close");
      if (!await page.$(".rail-empty")) throw new Error(`removing the final saved account did not leave a recoverable empty list ${JSON.stringify({ viewport, removed, hash: await page.evaluate(() => location.hash) })}`);
      await page.click(".saved-view");
    }
  });

  await check("landing animation runs automatically without controls and resumes after returning", async () => {
    const animationPage = await browser.newPage();
    let otherTab;
    animationPage.on("pageerror", (error) => errors.push("landing animation: " + error.message));
    try {
      await animationPage.setViewport({ width: 390, height: 844 });
      await animationPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await animationPage.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
      await animationPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const frame = () => animationPage.evaluate(() => ({
        globe: document.querySelector(".globe-graticule").getAttribute("d"),
        belt: getComputedStyle(document.querySelector(".mosaic-track")).transform,
        controls: document.querySelectorAll(".landing-motion, [data-act='toggle-landing-motion']").length,
        interfaceMode: document.documentElement.dataset.motion,
      }));
      const playing = await frame();
      await wait(550);
      const advanced = await frame();
      if (playing.controls || advanced.globe === playing.globe || advanced.belt === playing.belt ||
          advanced.interfaceMode !== "reduced") {
        throw new Error("the landing needs a control or is not playing automatically");
      }
      otherTab = await browser.newPage();
      await otherTab.bringToFront();
      await animationPage.waitForFunction(() => document.hidden && document.documentElement.dataset.mosaicMotion === "static");
      const paused = await frame();
      await wait(500);
      const stopped = await frame();
      if (paused.globe !== stopped.globe || paused.belt !== stopped.belt) {
        throw new Error("the hidden tab kept animating");
      }
      await animationPage.bringToFront();
      await otherTab.close();
      await animationPage.waitForFunction(() => document.documentElement.dataset.mosaicMotion === "animated");
      await animationPage.click(".nav-tab[data-view='explore']");
      await animationPage.click(".brand");
      await animationPage.waitForSelector(".archive-register");
      await animationPage.goto(BASE + "/?motion=off", { waitUntil: "domcontentloaded", timeout: 40000 });
      await animationPage.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const reloaded = await frame();
      await wait(500);
      if (reloaded.controls || (await frame()).belt === reloaded.belt) {
        throw new Error("returning or an obsolete motion link stopped the automatic background");
      }
    } finally {
      if (otherTab && !otherTab.isClosed()) await otherTab.close();
      await animationPage.close();
    }
  });
  await check("source spellings and same-place roles are clear in collection and history search", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?source-spelling=1#/explore?q=Lodz", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    const plain = await page.$$eval(".rail-card", (cards) => cards.map((card) => card.dataset.survivor));
    await page.$eval("#search", (input) => {
      input.value = "\u0141\u00f3d\u017a"; input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const polish = await page.$$eval(".rail-card", (cards) => cards.map((card) => card.dataset.survivor));
    if (!plain.length || plain.join() !== polish.join()) throw new Error("Lodz and its original spelling produce different accounts");
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready");
    await page.type("[data-country-search]", "\u0141\u00f3d\u017a");
    await page.click("[data-history-search] button");
    const matches = await page.$$eval("[data-history-match]", (buttons) => buttons.map((button) => ({
      index: button.dataset.historyMatch, name: button.querySelector("span").textContent,
    })));
    const city = matches.find((match) => match.name === "Lodz, Poland");
    if (!city || !matches.some((match) => match.name === "Lodz Ghetto, Poland")) {
      throw new Error("the original spelling did not find both the city and the distinct ghetto reference");
    }
    await page.click(`[data-history-match="${city.index}"]`);
    if (!await page.$eval("[data-search-status]", (status) => status.textContent.includes("Centred on Lodz"))) {
      throw new Error("the historical place search did not fold the original spelling");
    }
    const roles = await page.evaluate(async () => {
      const {loadData}=await import("./js/data.js");
      const store=await loadData();
      const events=store.eventsByYear.get(1944);
      return events.every(event=>{
        const button=document.querySelector(`[data-event="${CSS.escape(event.key)}"]`);
        return button?.querySelector("small").textContent.startsWith(`${event.role}.`);
      });
    });
    if (!roles) throw new Error("dated place rows still conceal their distinct source roles");
  });
  await check("year entry commits supported bounds and rejects invalid whole years explicitly", async () => {
    await page.goto(BASE + "/?year-entry-bounds=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    for (const [value, expected] of [["1800", "1914"], ["3000", "2026"]]) {
      await page.$eval("[data-year-entry]", (input, value) => {
        input.value=value;input.dispatchEvent(new Event("change",{bubbles:true}));
      }, value);
      const bounded=await page.evaluate(()=>({
        field:document.querySelector("[data-year-entry]").value,
        slider:document.querySelector("[data-scrub]").value,
        hash:location.hash,
        status:document.querySelector("[data-year-status]").textContent,
      }));
      if(bounded.field!==expected||bounded.slider!==expected||!bounded.hash.startsWith(`#/patterns/${expected}`)||
          !bounded.status.includes(`Showing ${expected}`)){
        throw new Error(`year entry and map disagree ${JSON.stringify(bounded)}`);
      }
    }
    await page.$eval("[data-year-entry]",input=>{
      input.value="1944.5";input.dispatchEvent(new Event("change",{bubbles:true}));
    });
    const invalid=await page.$eval("[data-year-entry]",input=>({valid:input.validity.valid,message:input.validationMessage,hash:location.hash}));
    if(invalid.valid||!invalid.message.includes("whole year")||!invalid.hash.startsWith("#/patterns/2026")){
      throw new Error(`invalid year was accepted without feedback ${JSON.stringify(invalid)}`);
    }
    await page.$eval("[data-year-entry]",input=>{
      input.value="1944";input.dispatchEvent(new Event("input",{bubbles:true}));
      input.form.requestSubmit();
    });
    if(await page.$eval("[data-year-entry]",input=>input.value!=="1944"||!input.validity.valid)){
      throw new Error("correcting the year did not clear its validation state");
    }
  });
  await check("counter labels and selected collection text meet accessibility requirements", async () => {
    await page.click(".brand");
    await page.waitForSelector(".archive-register");
    const counters=await page.$$eval(".register-item",items=>items.every(item=>item.getAttribute("role")==="group"&&item.getAttribute("aria-label")));
    if(!counters)throw new Error("archive counter labels lack an accessible role");
    await page.click(".nav-tab[data-view='explore']");
    await page.click(".rail-card");
    const contrast=await page.$eval(".rail-card.sel",card=>{
      const rgb=value=>value.match(/[\d.]+/g).slice(0,3).map(Number);
      const luminance=color=>color.map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
        .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
      const text=luminance(rgb(getComputedStyle(card.querySelector(".rail-intro")).color));
      const background=luminance(rgb(getComputedStyle(card).backgroundColor));
      return (Math.max(text,background)+.05)/(Math.min(text,background)+.05);
    });
    if(contrast<4.5)throw new Error(`selected-card text contrast is ${contrast.toFixed(2)}:1`);
  });

  await check("unreviewed accounts frame all mapped mentions without inventing solid routes", async () => {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewport(viewport);
      for (const [id, expectedCount] of [["baranek-martin", 7], ["adler-amek", 9]]) {
        await page.goto(BASE + `/?source-frame=${viewport.width}#/survivor/${id}`, { waitUntil: "domcontentloaded", timeout: 40000 });
        await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
        await page.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
        await wait(200);
        const frame = await page.evaluate(() => {
          const panel = document.querySelector(".panel").getBoundingClientRect();
          const rail = document.querySelector(".rail").getBoundingClientRect();
          const camera = document.querySelector(".camera").getScreenCTM();
          const points = [...document.querySelectorAll(".account-place-marker")].map(marker => {
            const point = new DOMPoint(marker.__data__.px, marker.__data__.py).matrixTransform(camera);
            return { x: point.x, y: point.y };
          });
          return {
            points, panel: { left: panel.left, top: panel.top }, railRight: rail.right,
            review: document.querySelectorAll(".account-place-marker.map-reference--review").length,
            summary: document.querySelector(".profile-route-status").textContent,
            routes: document.querySelectorAll(".explore-route").length,
          };
        });
        if (frame.points.length !== expectedCount || !frame.summary.startsWith(`${expectedCount} matched place mentions:`) ||
            !frame.review || (id === "baranek-martin" && frame.routes)) {
          throw new Error(`source references were hidden or promoted ${JSON.stringify({ id, frame })}`);
        }
        if (frame.points.some(point => viewport.width <= 820
          ? point.y >= frame.panel.top - 4 || point.y <= 100
          : point.x <= frame.railRight || point.x >= frame.panel.left)) {
          throw new Error(`references are hidden behind the reader ${JSON.stringify({ id, viewport, points: frame.points })}`);
        }
        await page.click(".map-tools [data-act='show-explore-map']");
        await wait(200);
        const expanded = await page.evaluate(() => {
          const camera = document.querySelector(".camera").getScreenCTM();
          const points = [...document.querySelectorAll(".account-place-marker")].map(marker =>
            new DOMPoint(marker.__data__.px, marker.__data__.py).matrixTransform(camera));
          return { width: Math.max(...points.map(p => p.x)) - Math.min(...points.map(p => p.x)),
            height: Math.max(...points.map(p => p.y)) - Math.min(...points.map(p => p.y)), mode: document.querySelector(".ov-explore").dataset.presentation };
        });
        if (expanded.mode !== "map" || Math.max(expanded.width, expanded.height) < 160) {
          throw new Error(`the full source map is still unreadable ${JSON.stringify({ id, expanded })}`);
        }
      }
    }
  });
  await check("collection clusters are keyboard reachable without thousands of rail tab stops", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?cluster-keyboard=1#/explore?limit=1176", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    const counts = await page.evaluate(() => ({
      accounts: document.querySelectorAll(".rail-card").length,
      tabStops: [...document.querySelectorAll(".rail-entry button")].filter(button => button.tabIndex === 0).length,
      clusters: document.querySelectorAll(".place-cluster").length,
      clusterStops: document.querySelectorAll(".place-cluster[tabindex='0']").length,
      heading: !!document.querySelector(".ov-explore h1"),
    }));
    if (counts.accounts < 1000 || counts.tabStops > 2 || !counts.clusters || counts.clusters > 160 ||
        counts.clusterStops !== 1 || !counts.heading) throw new Error(`keyboard navigation is not bounded ${JSON.stringify(counts)}`);
    await page.$eval(".rail-card", card => card.focus());
    const first = await page.evaluate(() => document.activeElement.dataset.survivor);
    await page.keyboard.press("ArrowDown");
    if (await page.evaluate(() => document.activeElement.dataset.survivor) === first) throw new Error("rail arrow navigation did not advance");
    await page.click("[data-act='focus-map']");
    const marker = await page.evaluate(() => ({ name: document.activeElement.getAttribute("aria-label"), key: document.activeElement.dataset.mapFocus }));
    await page.keyboard.press("ArrowRight");
    const next = await page.evaluate(() => ({
      name: document.activeElement.getAttribute("aria-label"), key: document.activeElement.dataset.mapFocus,
      announcement: document.getElementById("map-announcement").textContent,
    }));
    if (!marker.key || next.key === marker.key || !next.announcement) throw new Error(`map focus is not announced ${JSON.stringify({ marker, next })}`);
    await page.keyboard.press("Enter");
    const filtered = await page.evaluate(() => ({
      name: document.querySelector("[data-place-filter-name]").textContent,
      visible: !document.querySelector("[data-place-filter]").hidden,
      count: document.querySelectorAll(".rail-card").length,
    }));
    if (!filtered.name || !filtered.visible || !filtered.count) throw new Error(`a map place did not open its accounts ${JSON.stringify(filtered)}`);
  });
  await check("collection count labels stay legible without dropping place controls", async () => {
    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      await page.setViewport(viewport);
      await page.goto(BASE + `/?map-counts=${viewport.width}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
      await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const labelState = () => page.evaluate(() => {
        const labels = [...document.querySelectorAll(".place-cluster-count")];
        const rail = document.querySelector(".rail").getBoundingClientRect();
        const visible = labels.filter(label => {
          const box = label.getBoundingClientRect();
          return getComputedStyle(label).display !== "none" && box.width > 0 &&
            box.left >= (innerWidth > 820 ? rail.right : 0) && box.right <= innerWidth &&
            box.top > 70 && box.bottom < (innerWidth > 820 ? innerHeight : rail.top);
        });
        const boxes = visible.map(label => label.getBoundingClientRect());
        return {
          markers: document.querySelectorAll(".place-cluster").length,
          total: labels.length, visible: visible.length,
          overlaps: boxes.some((a, index) => boxes.slice(index + 1).some(b =>
            a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top)),
        };
      });
      const initial = await labelState();
      if (initial.markers < 100 || initial.visible < 3 || initial.visible >= initial.total || initial.overlaps) {
        throw new Error(`overview counts are not decluttered ${JSON.stringify({ viewport, initial })}`);
      }
      await page.click(".map-tools [data-act='zoom-in']");
      await page.click(".map-tools [data-act='zoom-in']");
      const zoomed = await labelState();
      if (zoomed.markers !== initial.markers || zoomed.overlaps) {
        throw new Error(`zoom hid places or overlapped counts ${JSON.stringify({ viewport, zoomed })}`);
      }
    }
  });
  await check("public profile paths contain readable source text and share metadata without JavaScript", async () => {
    const publicPage = await browser.newPage();
    try {
      await publicPage.setJavaScriptEnabled(false);
      const response = await publicPage.goto(BASE + "/survivor/adler-amek", { waitUntil: "domcontentloaded", timeout: 40000 });
      const source = await publicPage.evaluate(() => ({
        heading: document.querySelector("#server-profile h1")?.textContent,
        text: document.getElementById("server-profile")?.textContent,
        og: document.querySelector("meta[property='og:title']")?.content,
        image: document.querySelector("meta[property='og:image']")?.content,
        canonical: document.querySelector("link[rel='canonical']")?.href,
      }));
      if (response.status() !== 200 || !source.heading?.includes("Amek Adler") ||
          !source.text?.includes("Lublin") || !source.og?.includes("Amek Adler") ||
          !source.image?.includes("/wp-content/uploads/") || !source.canonical?.endsWith("/survivor/adler-amek")) {
        throw new Error(`the public profile is not source-readable ${JSON.stringify(source)}`);
      }
      const missing = await publicPage.goto(BASE + "/nonexistent-page", { waitUntil: "domcontentloaded" });
      if (missing.status() !== 404 || (await publicPage.$eval("body", body => body.innerText.trim())).length < 80) {
        throw new Error("the HTTP 404 is empty or has the wrong status");
      }
      await publicPage.setJavaScriptEnabled(true);
      await publicPage.click("a[href='/#/explore']");
      await publicPage.waitForSelector(".rail-card", { timeout: 15000 });
      if (await publicPage.$("#missing-title")) throw new Error("the server recovery link opened an unsupported route");
      await publicPage.goto(BASE + "/survivor/adler-amek", { waitUntil: "domcontentloaded" });
      await publicPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      if (await publicPage.$("#server-profile")) throw new Error("the static fallback remained over the interactive reader");
      if (await publicPage.$eval("#portrait-field", field => field.hasChildNodes())) {
        throw new Error("opening an account needlessly created the landing portrait belts");
      }
      await publicPage.click(".nav-tab[data-view='explore']");
      await publicPage.waitForSelector(".rail-card");
      if (await publicPage.$(".panel")) throw new Error("a real profile path trapped navigation in the account");
    } finally {
      await publicPage.close();
    }
  });
  await check("a valid server profile remains readable while the collection index catches up", async () => {
    const context = await browser.createBrowserContext();
    const lagPage = await context.newPage();
    lagPage.on("pageerror", error => errors.push("profile index lag: " + error.message));
    const index = await (await fetch(BASE + "/data/index.json")).json();
    index.features = index.features.filter(feature => feature.properties.survivor_id !== "adler-amek");
    let lagging = true;
    await lagPage.setRequestInterception(true);
    lagPage.on("request", request => request.url().includes("/data/index.json") && lagging
      ? request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(index) })
      : request.continue());
    try {
      await lagPage.goto(BASE + "/survivor/adler-amek", { waitUntil: "domcontentloaded", timeout: 40000 });
      await lagPage.waitForSelector("[data-server-profile-retry]:not([hidden])", { timeout: 15000 });
      const readable = await lagPage.evaluate(() => ({
        name: document.getElementById("server-profile-name")?.textContent,
        status: document.querySelector("[data-server-profile-status]")?.textContent,
        source: document.querySelector("#server-profile blockquote")?.textContent,
        missing: !!document.getElementById("missing-title"),
      }));
      if (!readable.name?.includes("Amek Adler") || !readable.status?.includes("still updating") ||
          !readable.source?.includes("Lublin") || readable.missing) {
        throw new Error(`a lagging index hid a valid account ${JSON.stringify(readable)}`);
      }
      lagging = false;
      await Promise.all([
        lagPage.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 40000 }),
        lagPage.click("[data-server-profile-retry]"),
      ]);
      await lagPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      if (await lagPage.$("#server-profile") || await lagPage.$eval("#profile-name", name => !name.textContent.includes("Amek Adler"))) {
        throw new Error("the current index did not restore the interactive account");
      }
    } finally {
      await context.close();
    }
  });
  await check("late profile details preserve map focus, camera and reader controls", async () => {
    const context = await browser.createBrowserContext();
    const detailPage = await context.newPage();
    detailPage.on("pageerror", error => errors.push("late profile: " + error.message));
    let release;
    const requested = new Promise(resolve => { release = resolve; });
    await detailPage.setViewport({ width: 1366, height: 850 });
    await detailPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await detailPage.setRequestInterception(true);
    detailPage.on("request", request => request.url().includes("/data/profiles/")
      ? release(request) : request.continue());
    try {
      await detailPage.goto(BASE + "/?late-profile=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await detailPage.waitForSelector(".panel[data-profile-state='loading']", { timeout: 15000 });
      const request = await Promise.race([requested, wait(15000).then(() => { throw new Error("profile details were never requested"); })]);
      await detailPage.click(".account-save");
      await detailPage.click("[data-act='toggle-account-reference']");
      await detailPage.click(".map-tools [data-act='zoom-in']");
      await detailPage.click("[data-act='focus-map']");
      const before = await detailPage.evaluate(() => {
        window.__retainedProfileNodes = [".panel-close", ".account-save", "#account-reference", ".rail-card.sel"]
          .map(selector => [selector, document.querySelector(selector)]);
        window.__retainedProfileFocus = document.activeElement;
        return document.querySelector(".camera").getAttribute("transform");
      });
      await request.continue();
      await detailPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      const retained = await detailPage.evaluate(() => ({
        nodes: window.__retainedProfileNodes.every(([selector, node]) => document.querySelector(selector) === node),
        focus: document.activeElement === window.__retainedProfileFocus,
        camera: document.querySelector(".camera").getAttribute("transform"),
        reference: !document.getElementById("account-reference").hidden,
        saved: document.querySelector(".account-save").getAttribute("aria-pressed"),
      }));
      if (!retained.nodes || !retained.focus || retained.camera !== before || !retained.reference || retained.saved !== "true") {
        throw new Error(`hydration interrupted the reader ${JSON.stringify(retained)}`);
      }
    } finally {
      await context.close();
    }
  });
  await check("profile loading failures recover without a full-archive fallback", async () => {
    const detailPage = await browser.newPage();
    detailPage.on("pageerror", error => errors.push("profile retry: " + error.message));
    await detailPage.setRequestInterception(true);
    let fail = true, fullArchive = false, detailRequests = 0;
    detailPage.on("request", request => {
      if (request.url().includes("/data/survivors.geojson")) fullArchive = true;
      if (request.url().includes("/data/profiles/")) {
        detailRequests++;
        if (fail) return request.respond({ status: 500, contentType: "application/json", body: "{}" });
      }
      request.continue();
    });
    try {
      await detailPage.goto(BASE + "/?detail-recovery=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await detailPage.waitForSelector(".panel[data-profile-state='error']", { timeout: 15000 });
      if (!await detailPage.$(".account-place-marker") || fullArchive) throw new Error("detail failure discarded the map or fetched the entire archive");
      fail = false;
      await detailPage.click("[data-act='retry-profile']");
      await detailPage.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      if (fullArchive || detailRequests !== 2 || !await detailPage.$(".profile-interviews")) {
        throw new Error("detail retry did not load exactly the selected account");
      }
      if (!await detailPage.$eval(".panel", panel => panel.contains(document.activeElement))) {
        throw new Error("retrying account details lost keyboard focus");
      }
    } finally {
      await detailPage.close();
    }
  });
  await check("history uses a neutral Germany label and both maps explain their symbols", async () => {
    await page.setViewport({ width: 1366, height: 850 });
    await page.goto(BASE + "/?neutral-symbol=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForFunction(() => document.documentElement.dataset.historicalBoundaries === "ready", { timeout: 15000 });
    const neutral = await page.$eval("[data-neutral-identifier='true']", marker => ({
      text: marker.textContent, image: !!marker.querySelector("image"),
      label: marker.getAttribute("aria-label"),
    }));
    if (!neutral.text.includes("Germany") || neutral.image || !neutral.label.includes("not a historical flag")) {
      throw new Error(`the sensitive symbol is still decorative ${JSON.stringify(neutral)}`);
    }
    if (!await page.$(".history-context-body .map-legend")) throw new Error("history has no map key");
    await page.click(".nav-tab[data-view='explore']");
    if (!await page.$(".explore-map-status .map-legend")) throw new Error("Explore has no map key");
    await page.$eval("#search", input => { input.value = "aushwitz"; input.dispatchEvent(new Event("input", { bubbles: true })); });
    await page.waitForSelector("[data-search-suggestion]");
    await page.click("[data-search-suggestion='Auschwitz']");
    if (!await page.$(".rail-card")) throw new Error("the suggested spelling did not return real accounts");
  });

  await check("review downloads preserve evidence without approving an account", async () => {
    await page.goto(BASE + "/?review-download=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
    await page.evaluate(() => {
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (blob) => { window.__reviewExport = blob; return create(blob); };
      const click = HTMLAnchorElement.prototype.click;
      HTMLAnchorElement.prototype.click = function () {
        if (this.download.endsWith("-review-source.json")) { window.__reviewFilename = this.download; return; }
        return click.call(this);
      };
    });
    await page.click(".review-tools > summary");
    await page.click("[data-act='download-review']");
    const exported = await page.evaluate(async () => ({
      file: window.__reviewFilename,
      data: JSON.parse(await window.__reviewExport.text()),
      pending: !!document.querySelector(".account-review-note"),
    }));
    const properties = exported.data.features?.[0]?.properties;
    if (exported.file !== "adam-wally-review-source.json" || exported.data.type !== "FeatureCollection" ||
        properties?.survivor_id !== "adam-wally" || !properties.profile_media ||
        !properties.waypoints.some(place => place.source_quote) || !exported.pending ||
        !exported.data.metadata.notice.includes("does not approve")) {
      throw new Error("the review source export omitted evidence or implied approval");
    }
  });
  await check("timeline speed can change without losing the chosen year", async () => {
    await page.goto(BASE + "/?timeline-speed=1#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("#loading", { hidden: true, timeout: 15000 });
    await page.click(".history-settings > summary");
    await page.select("[data-history-speed]", "4");
    await page.keyboard.press("Escape");
    await page.click("[data-act='play-history']");
    await page.waitForFunction(() => Number(document.querySelector("[data-year-entry]").value) >= 1946, { timeout: 2200 });
    await page.click("[data-act='play-history']");
    const paused = await page.$eval("[data-year-entry]", input => input.value);
    await wait(700);
    if (await page.$eval("[data-year-entry]", input => input.value) !== paused ||
        !await page.evaluate(() => location.hash.includes("speed=4"))) throw new Error("timeline speed lost its state or could not pause");
  });

  await check("the place index preserves city/site distinctions and exact filtered cohorts", async () => {
    const context = await browser.createBrowserContext();
    const discovery = await context.newPage();
    discovery.on("pageerror", error => errors.push("place index: " + error.message));
    const details = [];
    discovery.on("request", request => { if (request.url().includes("/data/profiles/")) details.push(request.url()); });
    try {
      await discovery.setViewport({ width: 1366, height: 850 });
      await discovery.goto(BASE + "/?place-index=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await discovery.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await discovery.click("[data-act='browse-places']");
      const opened = await discovery.evaluate(() => ({
        focus: document.activeElement.id,
        places: document.querySelectorAll("[data-directory-row]").length,
        stops: document.querySelectorAll("[data-browse-place][tabindex='0']").length,
      }));
      if (opened.focus !== "place-directory-search" || opened.places < 100 || opened.stops !== 1) {
        throw new Error(`the place index is not discoverable by keyboard ${JSON.stringify(opened)}`);
      }
      await discovery.$eval("#place-directory-search", input => {
        input.value = "Łódź"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const matches = await discovery.$$eval("[data-directory-row]:not([hidden]) button", buttons =>
        buttons.map(button => ({ name: button.dataset.browsePlace, count: Number(button.querySelector(".directory-account-count").textContent.split(" ")[0]) })));
      if (matches.length !== 2 || !matches.some(place => place.name.includes("Ghetto"))) {
        throw new Error(`the city and ghetto were silently conflated ${JSON.stringify(matches)}`);
      }
      await discovery.keyboard.press("ArrowDown");
      if (!await discovery.evaluate(() => document.activeElement.hasAttribute("data-browse-place"))) throw new Error("the place search cannot reach its results");
      await discovery.keyboard.press("End");
      const chosen = await discovery.evaluate(() => document.activeElement.dataset.browsePlace);
      const expected = matches.find(place => place.name === chosen).count;
      await discovery.keyboard.press("Enter");
      const result = await discovery.evaluate(() => ({
        count: document.querySelectorAll(".rail-card").length,
        place: document.querySelector("[data-place-filter-name]").textContent,
        dialog: !!document.querySelector("dialog[open]"),
      }));
      if (result.dialog || result.place !== chosen || result.count !== expected || details.length) {
        throw new Error(`a place did not open its exact lightweight cohort ${JSON.stringify({ result, expected, details })}`);
      }
      await discovery.click("[data-act='browse-places']");
      await discovery.keyboard.press("Escape");
      if (await discovery.evaluate(() => document.activeElement.dataset.act) !== "browse-places") throw new Error("closing the place index lost keyboard focus");
      await discovery.evaluate(() => localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids: ["adler-amek"] })));
      await discovery.click(".saved-view");
      await discovery.click("[data-act='browse-places']");
      await discovery.$eval("#place-directory-search", input => {
        input.value = "Canada"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      const sibling = await context.newPage();
      await sibling.goto(BASE + "/?place-index-storage=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await sibling.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await sibling.evaluate(() => localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids: ["adler-amek", "baranek-martin"] })));
      await discovery.bringToFront();
      await discovery.waitForFunction(() => document.querySelector("[data-browse-place='Canada'] .directory-account-count")?.textContent === "2 accounts", { timeout: 5000 });
      if (await discovery.$eval("#place-directory-search", input => input.value) !== "Canada") throw new Error("a saved-list update erased the place search");
      await sibling.close();
    } finally {
      await context.close();
    }
  });

  await check("explicit reading-list links transfer exact accounts without exposing other private saves", async () => {
    const senderContext = await browser.createBrowserContext();
    const recipientContext = await browser.createBrowserContext();
    const sender = await senderContext.newPage();
    const recipient = await recipientContext.newPage();
    sender.on("pageerror", error => errors.push("list sender: " + error.message));
    recipient.on("pageerror", error => errors.push("list recipient: " + error.message));
    try {
      await sender.goto(BASE + "/?list-sender=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await sender.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await sender.evaluate(() => localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({
        version: 1, ids: ["adler-amek", "baranek-martin", "adam-wally"],
      })));
      await sender.click(".saved-view");
      await sender.$eval("#search", input => {
        input.value = "Holocaust"; input.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await sender.click("[data-act='share-reading-list']");
      const address = await sender.$eval("#reading-list-address", field => field.value);
      const ids = new URLSearchParams(new URL(address).hash.split("?")[1]).get("list")?.split(",");
      if (ids?.join() !== "adler-amek,baranek-martin" || address.includes("Holocaust") || address.includes("saved=")) {
        throw new Error(`the link exposed unselected or private filters ${address}`);
      }
      await sender.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", { configurable: true,
          value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } });
        const create = URL.createObjectURL.bind(URL);
        URL.createObjectURL = blob => { window.__listSources = blob; return create(blob); };
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () { if (!this.download) click.call(this); };
      });
      await sender.click("[data-act='copy-reading-list']");
      const fallback = await sender.$eval("#reading-list-address", field =>
        field === document.activeElement && field.selectionEnd - field.selectionStart === field.value.length);
      if (!fallback) throw new Error("blocked copying did not select the portable list link");
      await sender.click("[data-act='download-shared-sources']");
      const citations = await sender.evaluate(() => window.__listSources.text());
      if (!citations.includes('"Amek Adler."') || !citations.includes('"Martin Baranek."') ||
          citations.includes("Wally Adam") || !citations.includes("not verbatim transcripts")) {
        throw new Error("downloaded citations do not match the explicitly shared selection");
      }
      await recipient.goto(BASE + "/?list-recipient=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await recipient.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await recipient.evaluate(() => localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids: ["adam-wally"] })));
      await recipient.goto(address, { waitUntil: "domcontentloaded", timeout: 40000 });
      await recipient.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const received = await recipient.evaluate(() => ({
        ids: [...document.querySelectorAll(".rail-card")].map(card => card.dataset.survivor),
        mappedIds: [...new Set([...document.querySelectorAll(".place-cluster")]
          .flatMap(marker => JSON.parse(marker.dataset.accountIds)))].sort(),
        saved: JSON.parse(localStorage.getItem("ohp-map.saved-accounts.v1")).ids,
        title: document.querySelector("[data-collection-title]").textContent,
      }));
      if (received.ids.join() !== ids.join() || received.mappedIds.join() !== [...ids].sort().join() ||
          received.saved.join() !== "adam-wally" || received.title !== "Shared reading list") {
        throw new Error(`receiving a link changed private state or lost accounts ${JSON.stringify(received)}`);
      }
      await recipient.click("[data-act='save-shared-list']");
      if (await recipient.evaluate(() => JSON.parse(localStorage.getItem("ohp-map.saved-accounts.v1")).ids.length) !== 3) {
        throw new Error("saving the shared list replaced the recipient's existing accounts");
      }
      await recipient.click(".rail-card");
      await recipient.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await recipient.click(".result-navigation:not(.result-navigation-end) [data-act='next-account']");
      if (!await recipient.evaluate(() => location.hash.includes("list=") && location.hash.includes("baranek-martin"))) {
        throw new Error("reader navigation escaped the shared selection");
      }
      await recipient.reload({ waitUntil: "domcontentloaded" });
      await recipient.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await recipient.click(".panel-close");
      if (await recipient.$$eval(".rail-card", cards => cards.length) !== 2) throw new Error("reloading an account lost the shared collection");
      await recipient.click(".saved-view");
      if (await recipient.$$eval(".rail-card", cards => cards.length) < 100 || await recipient.evaluate(() => location.hash.includes("list="))) {
        throw new Error("leaving a shared list did not restore the whole collection");
      }
    } finally {
      await senderContext.close();
      await recipientContext.close();
    }
  });

  await check("shared-list errors remain explicit and failed imports preserve existing saves", async () => {
    const context = await browser.createBrowserContext();
    const shared = await context.newPage();
    shared.on("pageerror", error => errors.push("shared list recovery: " + error.message));
    try {
      await shared.goto(BASE + "/?missing-shared=1#/explore?list=adler-amek,not-currently-public", { waitUntil: "domcontentloaded", timeout: 40000 });
      await shared.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      if (await shared.$$eval(".rail-card", cards => cards.length) !== 1 ||
          !await shared.$eval(".shared-list-warning", warning => warning.textContent.includes("1 account"))) {
        throw new Error("an unavailable shared account was silently dropped");
      }
      await shared.evaluate(() => {
        localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids: ["adam-wally"] }));
        Storage.prototype.setItem = () => { throw new DOMException("Blocked", "QuotaExceededError"); };
      });
      await shared.click("[data-act='save-shared-list']");
      if (!await shared.$eval("[data-saved-feedback]", feedback => feedback.textContent.includes("could not be saved")) ||
          await shared.evaluate(() => JSON.parse(localStorage.getItem("ohp-map.saved-accounts.v1")).ids.join()) !== "adam-wally") {
        throw new Error("a failed shared-list save reported success or replaced private data");
      }
      for (const query of ["list=%3Cscript%3E", "list=adler-amek&saved=1", "list="]) {
        await shared.goto(BASE + "/?invalid-shared=1#/explore?" + query, { waitUntil: "domcontentloaded", timeout: 40000 });
        await shared.waitForSelector("#missing-title", { timeout: 15000 });
      }
      await shared.goto(BASE + "/?unavailable-list=1#/explore?list=not-currently-public", { waitUntil: "domcontentloaded", timeout: 40000 });
      await shared.waitForSelector(".rail-empty", { timeout: 15000 });
      if (!await shared.$eval("[data-act='share-reading-list']", button => button.disabled)) throw new Error("an unavailable list can be silently reshared as empty");
      await shared.click("[data-act='leave-shared-list']");
      if (await shared.$$eval(".rail-card", cards => cards.length) < 100) throw new Error("an unavailable list has no recovery to the collection");
    } finally {
      await context.close();
    }
  });

  await check("large reading lists offer citations instead of silently shortened links", async () => {
    const context = await browser.createBrowserContext();
    const large = await context.newPage();
    large.on("pageerror", error => errors.push("large reading list: " + error.message));
    try {
      await large.goto(BASE + "/?large-reading-list=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await large.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const total = await large.evaluate(async () => {
        const index = await (await fetch("/data/index.json")).json();
        const ids = index.features.map(feature => feature.properties.survivor_id);
        localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids }));
        return ids.length;
      });
      await large.click(".saved-view");
      await large.click("[data-act='share-reading-list']");
      const recovery = await large.evaluate(() => ({
        text: document.querySelector(".research-dialog-intro").textContent,
        status: document.querySelector("[data-reading-list-status]").textContent,
        disabled: document.querySelector("[data-act='copy-reading-list']").disabled,
        exportEnabled: !document.querySelector("[data-act='download-shared-sources']").disabled,
      }));
      if (!recovery.text.includes(String(total)) || !recovery.status.includes("too large") || !recovery.disabled || !recovery.exportEnabled) {
        throw new Error(`the list was truncated or cannot be exported ${JSON.stringify(recovery)}`);
      }
    } finally {
      await context.close();
    }
  });

  await check("research dialogs fit small and landscape screens with usable close and copy controls", async () => {
    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      const context = await browser.createBrowserContext();
      const compact = await context.newPage();
      compact.on("pageerror", error => errors.push("compact research dialogs: " + error.message));
      try {
        await compact.setViewport(viewport);
        await compact.goto(BASE + "/?research-dialog-layout=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
        await compact.waitForSelector("#loading", { hidden: true, timeout: 15000 });
        await compact.click("[data-act='browse-places']");
        const fits = () => compact.$eval("dialog[open]", dialog => {
          const rect = dialog.getBoundingClientRect(), close = dialog.querySelector("[data-act='close-research-dialog']").getBoundingClientRect();
          return rect.left >= 8 && rect.right <= innerWidth - 8 && rect.top >= 8 && rect.bottom <= innerHeight - 8 &&
            close.width >= 44 && close.height >= 44 && close.top >= 8 && close.bottom <= innerHeight;
        });
        if (!await fits()) throw new Error(`the place index is clipped at ${viewport.width}px`);
        await compact.keyboard.press("Escape");
        await compact.evaluate(() => localStorage.setItem("ohp-map.saved-accounts.v1", JSON.stringify({ version: 1, ids: ["adler-amek", "baranek-martin"] })));
        await compact.click(".saved-view");
        await compact.click("[data-act='share-reading-list']");
        if (!await fits()) throw new Error(`the share dialog is clipped at ${viewport.width}px`);
        await compact.$eval("[data-act='copy-reading-list']", button => button.scrollIntoView({ block: "nearest" }));
        if (!await compact.$eval("[data-act='copy-reading-list']", button => button.getBoundingClientRect().height >= 44)) {
          throw new Error("the list-copy target is too small");
        }
        await compact.keyboard.press("Escape");
        if (await compact.evaluate(() => document.activeElement.dataset.act) !== "share-reading-list") throw new Error("closing the small-screen dialog lost focus");
      } finally {
        await context.close();
      }
    }
  });

  await check("closing the place index keeps an open account and its media intact", async () => {
    const context = await browser.createBrowserContext();
    const reading = await context.newPage();
    reading.on("pageerror", error => errors.push("place index reader: " + error.message));
    await reading.setRequestInterception(true);
    reading.on("request", request => request.url().startsWith("https://player.vimeo.com/video/")
      ? request.respond({ status: 200, contentType: "text/html", body: "<html><body>Player test</body></html>" })
      : request.continue());
    try {
      await reading.setViewport({ width: 1366, height: 850 });
      await reading.goto(BASE + "/?place-reader=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await reading.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await reading.click("[data-act='show-interviews']");
      await wait(600);
      await reading.click(".video-chapter[data-video]");
      await reading.waitForSelector(".player-frame iframe");
      await reading.$eval(".player-frame iframe", frame => { frame.dataset.retained = "yes"; });
      await reading.click("[data-act='browse-places']");
      await reading.keyboard.press("Escape");
      if (await reading.$eval(".player-frame iframe", frame => frame.dataset.retained) !== "yes" ||
          await reading.$eval("#profile-name", name => name.textContent) !== "Wally Adam") {
        throw new Error("dismissing the place index discarded the account or restarted its interview");
      }
    } finally {
      await context.close();
    }
  });

  await check("caption discovery filters real accounts, map references and saved URLs", async () => {
    const context = await browser.createBrowserContext();
    const captions = await context.newPage();
    captions.on("pageerror", error => errors.push("caption discovery: " + error.message));
    try {
      await captions.setViewport({ width: 1366, height: 850 });
      await captions.goto(BASE + "/?caption-discovery=1#/explore", { waitUntil: "domcontentloaded", timeout: 40000 });
      await captions.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      const expected = await captions.evaluate(async () => {
        const data = await (await fetch("/data/index.json")).json();
        const features = data.features.filter(feature => feature.properties.captioned_video_count > 0);
        return { count: features.length, ids: features.map(feature => feature.properties.survivor_id),
          mapped: features.filter(feature => feature.properties.waypoints.some(place => Number.isFinite(place.lat) && Number.isFinite(place.lng))).map(feature => feature.properties.survivor_id) };
      });
      await captions.click(".collection-filters summary");
      await captions.click("[data-caption-filter]");
      await captions.click(".collection-filters summary");
      const results = await captions.evaluate(() => ({
        count: document.querySelector("[data-rail-count]").textContent,
        ids: [...document.querySelectorAll(".rail-card")].map(card => card.dataset.survivor),
        mapped: [...new Set([...document.querySelectorAll(".place-cluster")].flatMap(marker => JSON.parse(marker.dataset.accountIds)))],
        hash: location.hash,
        summary: document.querySelector("[data-group-count]").textContent,
      }));
      if (!expected.count || !results.count.includes(`of ${expected.count} shown`) ||
          results.ids.some(id => !expected.ids.includes(id)) || results.mapped.length !== expected.mapped.length ||
          !results.hash.includes("captions=1") || !results.summary.includes("captions")) {
        throw new Error(`caption filtering lost its source cohort ${JSON.stringify({ expected: expected.count, results })}`);
      }
      await captions.click(".rail-card");
      await captions.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await captions.reload({ waitUntil: "domcontentloaded" });
      await captions.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await captions.click(".panel-close");
      if (!await captions.$eval("[data-caption-filter]", input => input.checked)) throw new Error("an account link lost its caption filter");
      await captions.click("[data-act='reset-search']");
      if (await captions.$eval("[data-caption-filter]", input => input.checked) ||
          await captions.evaluate(() => location.hash.includes("captions="))) throw new Error("resetting filters kept a hidden caption restriction");
      await captions.goto(BASE + "/?bad-caption-filter=1#/explore?captions=unknown", { waitUntil: "domcontentloaded", timeout: 40000 });
      await captions.waitForSelector("#missing-title", { timeout: 15000 });
    } finally {
      await context.close();
    }
  });

  await check("caption-filter controls remain reachable on small phones and landscape screens", async () => {
    for (const viewport of [{ width: 320, height: 568 }, { width: 568, height: 320 }]) {
      const context = await browser.createBrowserContext();
      const compact = await context.newPage();
      compact.on("pageerror", error => errors.push("compact caption filter: " + error.message));
      try {
        await compact.setViewport(viewport);
        await compact.goto(BASE + `/?caption-layout=${viewport.width}#/explore`, { waitUntil: "domcontentloaded", timeout: 40000 });
        await compact.waitForSelector("#loading", { hidden: true, timeout: 15000 });
        await compact.click(".collection-filters summary");
        await compact.click("[data-caption-filter]");
        await compact.click("[data-act='close-filters']");
        const usable = await compact.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          closed: !document.querySelector(".collection-filters").open,
          selected: document.querySelector("[data-caption-filter]").checked,
          rows: document.querySelectorAll(".rail-card").length,
          listHeight: document.querySelector("[data-rail-list]").getBoundingClientRect().height,
        }));
        if (usable.overflow || !usable.closed || !usable.selected || !usable.rows || usable.listHeight < 60) {
          throw new Error(`caption controls leave no usable results ${JSON.stringify({ viewport, usable })}`);
        }
      } finally {
        await context.close();
      }
    }
  });

  await check("account printing exposes complete source content and restores reader focus and camera", async () => {
    const context = await browser.createBrowserContext();
    const reading = await context.newPage();
    reading.on("pageerror", error => errors.push("account print: " + error.message));
    try {
      await reading.setViewport({ width: 1366, height: 850 });
      await reading.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
      await reading.goto(BASE + "/?print-account=1#/survivor/ferguson-george", { waitUntil: "domcontentloaded", timeout: 40000 });
      await reading.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      await reading.click(".map-tools [data-act='zoom-in']");
      await wait(200);
      const before = await reading.evaluate(() => {
        window.__printReader = document.querySelector(".panel");
        window.print = () => window.dispatchEvent(new Event("beforeprint"));
        return { camera: document.querySelector(".camera").getAttribute("transform"),
          places: [...document.querySelectorAll(".profile-places .step-place")].map(place => place.textContent),
          bio: document.querySelector(".bio").textContent };
      });
      await reading.click("[data-act='print-account']");
      await reading.emulateMediaType("print");
      const print = await reading.evaluate(() => {
        const sheet = document.getElementById("print-sheet");
        return { text: sheet.textContent, stageHidden: getComputedStyle(document.getElementById("stage")).display === "none",
          overflow: getComputedStyle(sheet).overflow, controls: sheet.querySelectorAll("button,iframe").length };
      });
      if (!print.stageHidden || print.overflow !== "visible" || print.controls ||
          !print.text.includes(before.bio) || before.places.some(place => !print.text.includes(place)) ||
          !print.text.includes("Accessed") || !print.text.includes("not a verbatim interview transcript")) {
        throw new Error("the account print sheet clipped, omitted or overstated source material");
      }
      await reading.emulateMediaType("screen");
      await reading.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      await wait(250);
      const restored = await reading.evaluate(() => ({
        sameReader: document.querySelector(".panel") === window.__printReader,
        sheet: !!document.getElementById("print-sheet"), focus: document.activeElement.dataset.act,
        camera: document.querySelector(".camera").getAttribute("transform"),
      }));
      if (!restored.sameReader || restored.sheet || restored.focus !== "print-account" || restored.camera !== before.camera) {
        throw new Error(`finishing or cancelling print changed the reader ${JSON.stringify(restored)}`);
      }
    } finally {
      await context.close();
    }
  });

  await check("reading-list printing uses the chosen snapshot without changing private saves", async () => {
    const context = await browser.createBrowserContext();
    const reading = await context.newPage();
    reading.on("pageerror", error => errors.push("reading-list print: " + error.message));
    try {
      await reading.goto(BASE + "/?print-list=1#/explore?list=adler-amek,baranek-martin", { waitUntil: "domcontentloaded", timeout: 40000 });
      await reading.waitForSelector("#loading", { hidden: true, timeout: 15000 });
      await reading.evaluate(() => {
        window.print = () => window.dispatchEvent(new Event("beforeprint"));
        window.__savedBeforePrint = localStorage.getItem("ohp-map.saved-accounts.v1");
      });
      await reading.click("[data-act='share-reading-list']");
      await reading.click("[data-act='print-reading-list']");
      const print = await reading.evaluate(() => ({
        text: document.querySelector(".print-reading-list").textContent,
        count: document.querySelectorAll(".print-reading-list .print-references > li").length,
        dialog: !!document.querySelector("dialog[open]"),
        unchanged: localStorage.getItem("ohp-map.saved-accounts.v1") === window.__savedBeforePrint,
      }));
      if (print.count !== 2 || !print.text.includes("Amek Adler") || !print.text.includes("Martin Baranek") ||
          print.text.includes("Wally Adam") || print.dialog || !print.unchanged) {
        throw new Error(`printing changed or lost the selected reading list ${JSON.stringify(print)}`);
      }
      await reading.evaluate(() => window.dispatchEvent(new Event("afterprint")));
      if (await reading.$("#print-sheet") || await reading.evaluate(() => document.activeElement.dataset.act) !== "share-reading-list") {
        throw new Error("printing the reading list left an orphaned sheet or lost focus");
      }
    } finally {
      await context.close();
    }
  });

  await check("exact source references survive reloads and produce clean share links", async () => {
    for (const viewport of [{ width: 1366, height: 850 }, { width: 390, height: 844 }]) {
      const context = await browser.createBrowserContext();
      const linked = await context.newPage();
      linked.on("pageerror", error => errors.push("reference link: " + error.message));
      try {
        await linked.setViewport(viewport);
        await linked.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
        await linked.goto(BASE + "/survivor/adam-wally?captions=1", { waitUntil: "domcontentloaded", timeout: 40000 });
        await linked.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
        await linked.click("[data-profile-section='profile-places']");
        await linked.click("[data-place-step='3']");
        await linked.waitForFunction(() => location.href.includes("ref=sha256%3A"), { timeout: 5000 });
        await linked.reload({ waitUntil: "domcontentloaded" });
        await linked.waitForSelector(".place-focus[aria-pressed='true']", { timeout: 15000 });
        if (await linked.$eval(".place-focus[aria-pressed='true'] .step-place", place => place.textContent) !== "Canada") {
          throw new Error("reloading lost the exact source reference");
        }
        if (!await linked.$eval(".profile-current-name", name => name.textContent === "Wally Adam" && name.getBoundingClientRect().width > 0)) {
          throw new Error("a deep reference lost the visible account identity");
        }
        await linked.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true,
          value: { writeText: async () => { throw new DOMException("Denied", "NotAllowedError"); } } }));
        await linked.click("[data-copy-reference='3']");
        await linked.waitForSelector("#reference-address-3:not([hidden])", { timeout: 5000 });
        const address = await linked.$eval("#reference-address-3", field => field.value);
        const url = new URL(address);
        if (url.pathname !== "/survivor/adam-wally" || [...url.searchParams.keys()].join() !== "ref" ||
            url.hash || !/^sha256:[a-f0-9]{64}$/.test(url.searchParams.get("ref"))) {
          throw new Error("the reference link exposed private browsing filters or lost its source key");
        }
        await linked.goto(address, { waitUntil: "domcontentloaded", timeout: 40000 });
        await linked.waitForSelector(".place-focus[aria-pressed='true']", { timeout: 15000 });
        if (await linked.$eval(".place-focus[aria-pressed='true'] .step-place", place => place.textContent) !== "Canada") {
          throw new Error("the clean reference link did not restore its source");
        }
        await linked.click(".map-tools [data-act='reset-map']");
        if (await linked.evaluate(() => location.href.includes("ref=")) || await linked.$(".place-focus[aria-pressed='true']")) {
          throw new Error("clearing the reference left a stale bookmark target");
        }
      } finally {
        await context.close();
      }
    }
  });

  await check("reference identities survive reordering and safely disclose changed or contextual sources", async () => {
    const { sourceReferenceKey } = await import("../js/reference-links.js");
    const index = await (await fetch(BASE + "/data/index.json")).json();
    const originalIndex = index.features.find(feature => feature.properties.survivor_id === "adam-wally");
    const original = await (await fetch(BASE + originalIndex.properties.detail_url)).json();
    const key = await sourceReferenceKey(original.properties, original.properties.waypoints[3]);
    for (const mode of ["reordered", "changed", "context"]) {
      const context = await browser.createBrowserContext();
      const linked = await context.newPage();
      linked.on("pageerror", error => errors.push("source identity: " + error.message));
      const nextIndex = structuredClone(index), next = structuredClone(original);
      const indexed = nextIndex.features.find(feature => feature.properties.survivor_id === "adam-wally");
      if (mode === "reordered") {
        indexed.properties.waypoints.reverse(); next.properties.waypoints.reverse();
      } else if (mode === "changed") {
        next.properties.waypoints[3].source_quote += " The source has changed.";
      } else {
        const mention = next.properties.waypoints.splice(3, 1)[0];
        mention.evidence = { ...mention.evidence, scope: "contextual", reason: "comparison" };
        next.properties.contextual_places = [...(next.properties.contextual_places || []), mention];
        indexed.properties.waypoints.splice(3, 1);
      }
      await linked.setRequestInterception(true);
      linked.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path === "/data/index.json") return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(nextIndex) });
        if (path.startsWith("/data/profiles/adam-wally.")) return request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(next) });
        request.continue();
      });
      try {
        await linked.setViewport({ width: 1366, height: 850 });
        await linked.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
        await linked.goto(BASE + "/survivor/adam-wally?ref=" + encodeURIComponent(key), { waitUntil: "domcontentloaded", timeout: 40000 });
        await linked.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
        if (mode === "reordered") {
          await linked.waitForSelector(".place-focus[aria-pressed='true']", { timeout: 5000 });
          const restored = await linked.$eval(".place-focus[aria-pressed='true']", place => ({
            index: Number(place.dataset.placeStep), name: place.querySelector(".step-place").textContent,
          }));
          if (restored.name !== "Canada" || restored.index !== original.properties.waypoints.length - 4) {
            throw new Error("a reordered source link guessed an array position");
          }
        } else {
          const expected = mode === "changed" ? "no longer matches" : "source context";
          await linked.waitForFunction(text => document.querySelector("[data-reference-notice]")?.textContent.includes(text), { timeout: 5000 }, expected);
          if (await linked.$(".place-focus[aria-pressed='true']") || await linked.$("#missing-title")) {
            throw new Error("a changed source was silently focused or replaced a valid account");
          }
          if (mode === "context" && !await linked.$eval("details.contextual-places", details => details.open)) {
            throw new Error("the retained source context was not made readable");
          }
        }
      } finally {
        await context.close();
      }
    }
  });

  await check("invalid reference links keep the account readable and offer a clean recovery", async () => {
    const context = await browser.createBrowserContext();
    const invalid = await context.newPage();
    invalid.on("pageerror", error => errors.push("invalid source link: " + error.message));
    try {
      await invalid.goto(BASE + "/survivor/adam-wally?ref=not-a-source-key", { waitUntil: "domcontentloaded", timeout: 40000 });
      await invalid.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      if (!await invalid.$eval("[data-reference-notice]", notice => notice.textContent.includes("invalid")) ||
          await invalid.$(".place-focus[aria-pressed='true']")) throw new Error("an invalid source key was ignored or guessed");
      await invalid.click("[data-act='clear-reference']");
      if (await invalid.evaluate(() => location.href.includes("ref=")) ||
          await invalid.$eval("[data-reference-notice]", notice => !notice.hidden)) {
        throw new Error("reference recovery left an invalid key in the address");
      }
      if (!await invalid.$(".bio")) throw new Error("reference recovery lost the account");
    } finally {
      await context.close();
    }
  });

  await check("related reading explains shared places and preserves the current collection scope", async () => {
    const context = await browser.createBrowserContext();
    const related = await context.newPage();
    related.on("pageerror", error => errors.push("related reading: " + error.message));
    try {
      await related.setViewport({ width: 1366, height: 850 });
      await related.goto(BASE + "/?related-reading=1#/survivor/adam-wally", { waitUntil: "domcontentloaded", timeout: 40000 });
      await related.waitForSelector("[data-related-account]", { timeout: 15000 });
      const rows = await related.$$eval("[data-related-account]", buttons => buttons.map(button => ({
        id: button.dataset.relatedAccount, why: button.querySelector("small").textContent,
      })));
      if (!rows.length || rows.length > 3 || rows.some(row => row.id === "adam-wally" || !row.why.includes("Also names"))) {
        throw new Error("related accounts lack a specific source-based reason");
      }
      if (!await related.$eval(".related-reading > p", note => note.textContent.includes("do not establish shared travel or contact"))) {
        throw new Error("related reading implies an unsupported personal connection");
      }
      const target = rows[0].id;
      const ids = ["adam-wally", target].join(",");
      await related.goto(BASE + "/?related-scope=1#/survivor/adam-wally?list=" + ids, { waitUntil: "domcontentloaded", timeout: 40000 });
      await related.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      const scoped = await related.$$eval("[data-related-account]", buttons => buttons.map(button => button.dataset.relatedAccount));
      if (scoped.join() !== target) throw new Error("related reading escaped the shared selection");
      await related.click(`[data-related-account='${target}']`);
      await related.waitForSelector(".panel[data-profile-state='ready']", { timeout: 15000 });
      const restoredIds = new URLSearchParams(new URL(await related.url()).hash.split("?")[1]).get("list");
      if (!restoredIds?.includes("adam-wally") || !restoredIds.includes(target)) throw new Error("a related account discarded the reading-list context");
    } finally {
      await context.close();
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
