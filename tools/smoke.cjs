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
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => { if (!/favicon/.test(r.url())) errors.push("requestfailed: " + r.url()); });

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 40000 });
  await page.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
  await wait(900);

  await check("landing globe + clear copy", async () => {
    const globePaths = await page.$$eval("#map .globe path", (e) => e.length);
    if (globePaths < 50) throw new Error("only " + globePaths + " globe paths");
    const lede = await page.$eval(".landing-card .lede", (el) => el.textContent.toLowerCase());
    if (!/survivor/.test(lede) || !/veteran/.test(lede)) throw new Error("lede missing survivors/veterans");
    const scale = await page.$eval(".scale", (el) => el.textContent.replace(/\s+/g, " ").trim());
    if (!/\d+ people/.test(scale)) throw new Error("scale='" + scale + "'");
  });
  await check("follow -> guided narrative + flat map", async () => {
    await page.click(".landing-card [data-act='follow']");
    await page.waitForSelector(".narr .chapter", { timeout: 5000 });
    const flatPaths = await page.$$eval("#map .camera path", (e) => e.length);
    if (flatPaths < 20) throw new Error("flat map not drawn (" + flatPaths + ")");
  });
  await check("explore: group chips + grouped rail", async () => {
    await page.click(".nav-tab[data-view='explore']");
    await page.waitForSelector(".rail .gchip", { timeout: 5000 });
    await page.waitForSelector(".rail .rail-ghead", { timeout: 5000 });
    const chips = await page.$$eval(".gchip", (e) => e.length);
    if (chips < 1) throw new Error("no group chips");
  });
  await check("search filters the rail", async () => {
    await page.type("#search", "auschwitz");
    await wait(350);
    const cnt = await page.$eval("[data-rail-count]", (el) => el.textContent);
    if (!/of \d+ shown/.test(cnt)) throw new Error("count='" + cnt + "'");
  });
  await check("select a person shows panel", async () => {
    await page.$eval("#search", (el) => { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); });
    await wait(250);
    await page.click(".rail .rail-card");
    await page.waitForSelector(".panel .journey", { timeout: 5000 });
    await page.waitForSelector(".panel .panel-group", { timeout: 3000 });
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
  await check("patterns + scrubber + density toggle", async () => {
    await page.click(".nav-tab[data-view='patterns']");
    await page.waitForSelector(".scrubber .range", { timeout: 5000 });
    await page.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
    const yr = await page.$eval(".scrub-year", (el) => el.textContent);
    if (yr !== "1944") throw new Error("year=" + yr);
    await page.click(".seg[data-layer='origins']");
    await page.waitForSelector(".origin-list li", { timeout: 5000 });
  });
  await check("about renders", async () => {
    await page.click(".nav-plain[data-view='about']");
    await page.waitForSelector(".about-wrap .about-grid", { timeout: 5000 });
  });

  await browser.close();
  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
