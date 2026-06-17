// Headless smoke test for the D3-atlas front end. Exercises the landing, all three
// modes, a survivor selection, the scrubber, the About view, and a deep link; fails on
// any console error or uncaught exception.
const puppeteer = require("puppeteer-core");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = process.argv[2] || "http://localhost:8124";

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox", "--disable-gpu"] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => {
    const u = r.url();
    if (!/basemaps\.cartocdn|favicon/.test(u)) errors.push("requestfailed: " + u);
  });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await page.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
  await wait(800);

  await check("basemap drew countries", async () => {
    const paths = await page.$$eval("#map svg path", (e) => e.length);
    if (paths < 20) throw new Error("only " + paths + " country paths");
  });
  await check("landing shows scale + actions", async () => {
    await page.waitForSelector(".landing-card .cta-row [data-act='follow']", { timeout: 5000 });
    const scale = await page.$eval(".scale", (el) => el.textContent.replace(/\s+/g, " ").trim());
    if (!/\d+ survivors/.test(scale)) throw new Error("scale='" + scale + "'");
  });
  await check("follow one journey → guided narrative", async () => {
    await page.click(".landing-card [data-act='follow']");
    await page.waitForSelector(".narr .chapter", { timeout: 5000 });
    const chapters = await page.$$eval(".narr .chapter", (e) => e.length);
    if (chapters < 3) throw new Error("only " + chapters + " chapters");
  });
  await check("explore: rail + map dots + select + panel", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .rail-card", { timeout: 5000 });
    await page.click(".rail .rail-card");
    await page.waitForSelector(".panel .journey", { timeout: 5000 });
    const mini = await page.$$eval(".panel .mini path", (e) => e.length);
    if (mini < 1) throw new Error("mini route not drawn");
  });
  await check("filter chip narrows the rail", async () => {
    await page.click(".filterbar .chip");
    await wait(300);
    const label = await page.$eval(".rail .micro-label", (el) => el.textContent);
    if (!/of \d+ survivors/.test(label)) throw new Error("label='" + label + "'");
  });
  await check("patterns + scrubber moves", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const yr = await page.$eval(".scrub-year", (el) => el.textContent);
    if (yr !== "1944") throw new Error("year=" + yr);
  });
  await check("about view renders", async () => {
    await page.click(".nav-plain[data-view='about']");
    await page.waitForSelector(".about-wrap .about-grid", { timeout: 5000 });
  });
  await check("deep link #/survivor/<id> selects", async () => {
    const id = await page.evaluate(() => {
      // pick any survivor id from the rail by navigating explore first
      return null;
    });
    await page.goto(BASE + "/#/survivor/baranek-martin", { waitUntil: "networkidle2" });
    await page.waitForSelector(".panel .journey", { timeout: 6000 });
  });

  await browser.close();
  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
