// Headless smoke test for the world-atlas front end (globe landing, free zoom, search,
// group filters, density). Fails on any console error or uncaught exception.
const puppeteer = require("puppeteer-core");
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
  page.on("pageerror", (e) => errors.push("pageerror: " + (e.stack || e.message)));
  page.on("requestfailed", (r) => { if (!/favicon/.test(r.url())) errors.push("requestfailed: " + r.url()); });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
  await page.evaluate(() => {
    const samples = [];
    const capture = () => {
      const values = [...document.querySelectorAll("[data-counter]")]
        .map((counter) => Number(counter.textContent.replace(/,/g, "")));
      if (values.length && samples.length < 500) samples.push(values);
    };
    const observer = new MutationObserver(capture);
    observer.observe(document.querySelector("#overlay"), {
      childList: true,
      subtree: true,
      characterData: true,
    });
    window.__initialCounterCapture = { observer, samples };
  });
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
    if (loading.title !== "Journeys" || loading.status !== "Opening the archive") {
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
  await check("follow -> guided narrative + flat map", async () => {
    await page.click(".landing-card [data-act='follow']");
    await page.waitForSelector(".narr .chapter", { timeout: 5000 });
    if (await page.$(".follow-another")) throw new Error("Guided chooser should not render");
    const flatPaths = await page.$$eval("#map .camera path", (e) => e.length);
    if (flatPaths < 20) throw new Error("flat map not drawn (" + flatPaths + ")");
    const chapterCount = await page.$$eval("[data-chapter]", (chapters) => chapters.length);
    if (chapterCount < 3) throw new Error("guided journey has too few chapters to test");
    const activateChapter = (index) => page.$eval("[data-narr]", (narrative, chapterIndex) => {
      const chapter = narrative.querySelectorAll("[data-chapter]")[chapterIndex];
      narrative.scrollTop = chapter.offsetTop -
        narrative.clientHeight / 2 + chapter.offsetHeight / 2;
      narrative.dispatchEvent(new Event("scroll"));
    }, index);
    const revealedLength = () => page.$eval(".guided-route", (path) => {
      const total = path.getTotalLength();
      return total - (Number(path.getAttribute("stroke-dashoffset")) || 0);
    });

    await activateChapter(1);
    await wait(150);
    const beforeRapidAdvance = await revealedLength();
    await activateChapter(2);
    await wait(30);
    const afterRapidAdvance = await revealedLength();
    if (afterRapidAdvance > beforeRapidAdvance + 4) {
      throw new Error(
        `rapid scroll jumped from ${beforeRapidAdvance.toFixed(2)} to ${afterRapidAdvance.toFixed(2)}`,
      );
    }

    const target = await page.evaluate(() => {
      const narrative = document.querySelector("[data-narr]");
      const chapters = [...narrative.querySelectorAll("[data-chapter]")];
      const last = Math.min(3, chapters.length - 1);
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
    await wait(1000);
    const guidedRoute = await page.evaluate(() => {
      const active = Number(document.querySelector("[data-chapter].is-active")?.dataset.chapter);
      const paths = [...document.querySelectorAll("#map .guided-route")];
      return {
        active,
        count: paths.length,
        unfinished: paths.filter((path) => Number(path.getAttribute("stroke-dashoffset")) > 0.1).length,
        moveCommands: paths.map((path) => (path.getAttribute("d").match(/M/g) || []).length),
        joins: paths.map((path) => path.getAttribute("stroke-linejoin")),
      };
    });
    if (guidedRoute.active !== target ||
        guidedRoute.count !== 1 ||
        guidedRoute.unfinished ||
        guidedRoute.moveCommands.some((count) => count !== 1) ||
        guidedRoute.joins.some((join) => join !== "round")) {
      throw new Error(`unstable route state ${JSON.stringify(guidedRoute)}`);
    }
    await page.click("[data-act='prev-chapter']");
    await page.waitForFunction(
      (index) => document.querySelector("[data-chapter].is-active")?.dataset.chapter === String(index),
      { timeout: 5000 }, target - 1,
    );
    await wait(950);
    const reading = await page.evaluate(() => {
      const narrative = document.querySelector("[data-narr]").getBoundingClientRect();
      const marker = document.querySelector(".guided-ring");
      const point = new DOMPoint(Number(marker.getAttribute("cx")), Number(marker.getAttribute("cy")))
        .matrixTransform(marker.getScreenCTM());
      return { pointX: point.x, pointY: point.y, sheetRight: narrative.right, count: document.querySelector("[data-guided-count]").textContent };
    });
    if (reading.pointX < reading.sheetRight + 12 || !reading.count.startsWith(`Place ${target} of`)) {
      throw new Error(`guided navigation or map framing failed ${JSON.stringify(reading)}`);
    }
  });
  await check("explore: group chips + grouped rail", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .gchip", { timeout: 5000 });
    await page.waitForSelector(".rail .rail-ghead", { timeout: 5000 });
    const chips = await page.$$eval(".gchip", (e) => e.length);
    const profilePictures = await page.$$eval(".rail-card .medal img", (images) => images.length);
    if (chips < 1) throw new Error("no group chips");
    if (profilePictures < 130) throw new Error(`only ${profilePictures} profile pictures were restored`);
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
      selected: [...document.querySelectorAll(".gchip[aria-pressed='true']")].map((button) => button.dataset.group),
      groups: [...document.querySelectorAll(".rail-ghead")].map((element) => element.textContent.trim()),
    }));
    if (filtered.selected.length !== 1 || filtered.selected[0] !== "Military Veterans" ||
        filtered.groups.length !== 1 || !filtered.groups[0].startsWith("Military Veterans")) {
      throw new Error(`community filter failed ${JSON.stringify(filtered)}`);
    }
    await page.click("[data-group='Military Veterans']");
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
    await page.waitForSelector(".panel .service-context", { timeout: 3000 });
    const serviceMap = await page.evaluate(() => ({
      context: document.querySelector(".service-context strong")?.textContent,
      coalition: document.querySelectorAll("#map [data-war-side='coalition']").length,
      opposition: document.querySelectorAll("#map [data-war-side='opposition']").length,
      bio: document.querySelector(".panel .bio")?.textContent.trim(),
      recording: document.querySelector(".panel .recording-meta")?.textContent.replace(/\s+/g, " ").trim(),
      restoredPicture: Boolean(document.querySelector(".panel .medal img")),
    }));
    if (serviceMap.context !== "Second World War" || !serviceMap.coalition || !serviceMap.opposition ||
        serviceMap.bio.length < 200 || /…$/.test(serviceMap.bio) ||
        !/[.!?][”"')\]]?$/.test(serviceMap.bio) ||
        !/interview chapters?/.test(serviceMap.recording || "") ||
        !/no public captions/.test(serviceMap.recording || "") ||
        !serviceMap.restoredPicture) {
      throw new Error(`veteran service context is incomplete ${JSON.stringify(serviceMap)}`);
    }
    await page.click(".guided-pill");
    await page.waitForSelector("[data-narr]");
    if (await page.$(".guided-portrait")) {
      throw new Error("an unvalidated gallery image was enlarged in Guided");
    }
    await page.click(".nav-tab[data-view='explore']");
    await page.setViewport({ width: 1200, height: 800 });
    await wait(1300);
    const reframed = await page.$eval("#map .camera", (camera) => Number(
      camera.getAttribute("transform").match(/scale\(([^)]+)\)/)[1],
    ));
    if (reframed <= 1.01) throw new Error("resizing lost the selected account's map framing");
    await page.setViewport({ width: 1366, height: 850 });
    await wait(1300);
  });
  await check("unavailable Vimeo coverage is not reported as absent", async () => {
    await page.$eval("#search", (input) => {
      input.value = "Morris Adams";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await wait(250);
    await page.waitForSelector("[data-survivor='adams-morris']", { timeout: 3000 });
    await page.click("[data-survivor='adams-morris']");
    const coverage = await page.$eval(
      ".panel .recording-meta",
      (element) => element.textContent.replace(/\s+/g, " ").trim(),
    );
    if (!/caption status unavailable/.test(coverage) || /no public captions/.test(coverage)) {
      throw new Error(`unavailable caption coverage is misleading: ${coverage}`);
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
    const coverage = await page.$eval(
      ".panel .recording-meta",
      (element) => element.textContent.replace(/\s+/g, " ").trim(),
    );
    if (!/6 interview chapters/.test(coverage) || !/6 with public captions/.test(coverage)) {
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
    await page.$eval(".guided-pill", (button) => button.click());
    await page.waitForSelector(".narr-head .guided-portrait img", { timeout: 5000 });
    const guidedPortrait = await page.evaluate(() => {
      const head = document.querySelector(".narr-head").getBoundingClientRect();
      const portrait = document.querySelector(".guided-portrait");
      const box = portrait.getBoundingClientRect();
      return {
        alt: portrait.querySelector("img")?.alt,
        withinHeading: box.top >= head.top && box.bottom <= head.bottom,
        radius: parseFloat(getComputedStyle(portrait).borderRadius),
      };
    });
    if (guidedPortrait.alt !== "Wally Adam" || !guidedPortrait.withinHeading || guidedPortrait.radius > 4) {
      throw new Error(`guided archive photograph is incorrect ${JSON.stringify(guidedPortrait)}`);
    }
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .rail-card", { timeout: 5000 });
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
    const yr = await page.$eval(".scrub-year", (el) => el.textContent);
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
      selectedRoutes: document.querySelectorAll(".selected-testimony-route").length,
      errorMessage: (() => {
        const root = document.documentElement;
        root.dataset.historicalBoundaries = "error";
        const content = getComputedStyle(
          document.querySelector(".war-brief-content > small"),
          "::after",
        ).content;
        root.dataset.historicalBoundaries = "ready";
        return content;
      })(),
    }));
    if (!eventState.markers || eventState.activeMarkers || eventState.selectedRoutes) {
      throw new Error("historical event layer should open without a forced selection");
    }
    if (eventState.phase !== "Allied armies advance from west and east" ||
        eventState.canada !== "coalition" ||
        eventState.germany !== "opposition" ||
        eventState.territories < 140 ||
        !eventState.occupied ||
        !eventState.corridors ||
        eventState.corridors > 8 ||
        !/historical geometry unavailable/.test(eventState.errorMessage || "")) {
      throw new Error(`historical war layer is incomplete ${JSON.stringify(eventState)}`);
    }
    await page.$eval(".pattern-event-marker", (marker) => {
      marker.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.waitForSelector(".testimony-moment.is-selected", { timeout: 3000 });
    const selection = await page.evaluate(() => ({
      selectedRoutes: document.querySelectorAll(".selected-testimony-route").length,
      segmentedRoutes: [...document.querySelectorAll(".selected-testimony-route")]
        .filter((path) => (path.getAttribute("d").match(/M/g) || []).length !== 1).length,
      place: document.querySelector(".testimony-moment.is-selected > strong")?.textContent,
      eventPosition: document.querySelector(".moment-nav b")?.textContent,
    }));
    if (!selection.selectedRoutes || selection.selectedRoutes > 4 || selection.segmentedRoutes ||
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
    const nextYear = await page.$eval(".scrub-year", (el) => Number(el.textContent));
    if (nextYear !== beforeYear + 1) {
      throw new Error(`timeline did not advance exactly one year (${beforeYear} -> ${nextYear})`);
    }
    await page.$eval(".seg[data-layer='origins']", (button) => button.click());
    await page.waitForSelector(".origin-list li", { timeout: 5000 });
  });
  await check("about renders", async () => {
    await page.click(".nav-plain[data-view='about']");
    await page.waitForSelector(".about-wrap .about-grid", { timeout: 5000 });
    const about = await page.evaluate(() => ({
      sources: document.querySelectorAll(".about-sources dd").length,
      communities: document.querySelectorAll(".collection-ledger dd").length,
      current: document.querySelector("[aria-current='page']")?.dataset.view,
    }));
    if (about.sources !== 5 || about.communities !== 5 || about.current !== "about") {
      throw new Error(`archive source ledger is incomplete ${JSON.stringify(about)}`);
    }
  });
  await check("patterns deep link opens at the 1944 war map", async () => {
    await page.goto(BASE + "/?deep-link=patterns#/patterns/1944", { waitUntil: "domcontentloaded", timeout: 40000 });
    await page.waitForSelector("[data-war-context]", { timeout: 15000 });
    const state = await page.evaluate(() => ({
      year: document.querySelector(".scrub-year")?.textContent,
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
        return { top: panel.top, endpoints, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      if (profile.overflow ||
          (viewport.width <= 820 && profile.endpoints.some((y) => y >= profile.top - 4 || y <= 100))) {
        throw new Error(`profile map is obscured at ${viewport.width}px ${JSON.stringify(profile)}`);
      }
      await page.click(".guided-pill");
      await page.waitForSelector(".guided-ring");
      await wait(1000);
      const guided = await page.evaluate(() => {
        const sheet = document.querySelector(".narr").getBoundingClientRect();
        const ring = document.querySelector(".guided-ring");
        const point = new DOMPoint(Number(ring.getAttribute("cx")), Number(ring.getAttribute("cy")))
          .matrixTransform(ring.getScreenCTM());
        const next = document.querySelector("[data-act='next-chapter']").getBoundingClientRect();
        const hit = document.elementFromPoint(next.x + next.width / 2, next.y + next.height / 2);
        return { x: point.x, y: point.y, top: sheet.top, right: sheet.right, nextClickable: hit?.closest("button")?.dataset.act === "next-chapter" };
      });
      if (!guided.nextClickable || (viewport.width <= 820 ? guided.y >= guided.top - 8 : guided.x <= guided.right + 8)) {
        throw new Error(`guided map or controls are obscured at ${viewport.width}px ${JSON.stringify(guided)}`);
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
    await staticPage.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "no-preference" }]);
    await staticPage.setRequestInterception(true);
    staticPage.on("request", (request) => {
      if (request.url().includes("/vendor/gsap/")) {
        request.respond({ status: 200, contentType: "application/javascript", body: "" });
      } else request.continue();
    });
    await staticPage.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 40000 });
    await staticPage.waitForSelector(".archive-register", { timeout: 15000 });
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

  await browser.close();
  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
