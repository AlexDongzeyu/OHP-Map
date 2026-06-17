// Headless smoke test: load the site in Edge, exercise all three modes + the
// scrubber + a deep link, and fail on any console error or uncaught exception.
const puppeteer = require("puppeteer-core");

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:8124";

(async () => {
  const errors = [];
  const browser = await puppeteer.launch({
    executablePath: EDGE,
    headless: "new",
    args: ["--no-sandbox", "--disable-gpu"],
  });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("requestfailed", (r) => {
    const u = r.url();
    // CARTO basemap tiles need the internet; ignore those in the smoke test.
    if (!u.includes("basemaps.cartocdn.com")) errors.push("requestfailed: " + u);
  });

  async function check(label, fn) {
    try { await fn(); console.log("PASS " + label); }
    catch (e) { errors.push(label + ": " + e.message); console.log("FAIL " + label + " :: " + e.message); }
  }

  // 1) Landing intro first (no hash): a stranger must see purpose + actions.
  await page.goto(BASE + "/", { waitUntil: "networkidle2", timeout: 30000 });
  await check("intro hero shows scale + actions", async () => {
    await page.waitForSelector("#intro .intro-actions [data-go]", { timeout: 5000 });
    const scale = await page.$eval("#scale", (el) => el.textContent.trim());
    if (!/\d+ survivors/.test(scale)) throw new Error("scale='" + scale + "'");
    const introHidden = await page.$eval("#intro", (el) => el.hidden);
    if (introHidden) throw new Error("intro hidden on first load");
  });
  await check("primary action enters guided + reveals shell", async () => {
    await page.click('#intro [data-go="guided"]');
    await page.waitForSelector(".topbar:not([hidden])", { timeout: 5000 });
    await page.waitForSelector("#panel .step", { timeout: 5000 });
  });

  await check("data loaded (survivor count > 0)", async () => {
    const n = await page.$eval("#survivor-count", (el) => parseInt(el.textContent, 10));
    if (!(n > 0)) throw new Error("count=" + n);
  });
  await check("notice banner visible (pending data)", async () => {
    const hidden = await page.$eval("#notice-banner", (el) => el.hidden);
    if (hidden) throw new Error("banner hidden");
  });
  await check("guided steps rendered", async () => {
    const steps = await page.$$eval("#panel .step", (els) => els.length);
    if (steps < 3) throw new Error("only " + steps + " steps");
  });

  await check("explore mode + markers + filter", async () => {
    await page.click('.mode-tab[data-mode="explore"]');
    await page.waitForSelector("#panel .filterbar", { timeout: 5000 });
    await page.waitForSelector("#panel .result", { timeout: 5000 });
    await page.waitForSelector(".leaflet-marker-icon", { timeout: 5000 });
    const scrubberHidden = await page.$eval("#scrubber", (el) => el.hidden);
    if (scrubberHidden) throw new Error("scrubber not shown in explore");
  });

  await check("select a survivor shows detail", async () => {
    await page.click("#panel .result");
    await page.waitForSelector("#panel .detail .card", { timeout: 5000 });
    const h = await page.$eval("#panel .detail h2", (el) => el.textContent);
    if (!h) throw new Error("no detail heading");
  });

  await check("scrubber moves to 1944", async () => {
    await page.$eval('#scrubber input[type=range]', (el) => {
      el.value = "1944";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const year = await page.$eval("#scrubber [data-year]", (el) => el.textContent);
    if (year !== "1944") throw new Error("year=" + year);
  });

  await check("patterns mode + connections list", async () => {
    await page.click('.mode-tab[data-mode="patterns"]');
    await page.waitForSelector("#panel .patterns", { timeout: 5000 });
    const conns = await page.$$eval("#panel .conns li", (els) => els.length);
    if (conns < 1) throw new Error("no connections listed");
  });

  await check("about modal opens + closes", async () => {
    await page.click("#about-tab");
    await page.waitForSelector("#about:not([hidden])", { timeout: 4000 });
    await page.click("#about-close");
    await new Promise((r) => setTimeout(r, 400));
  });

  await check("deep link #/place/ works (skips intro)", async () => {
    await page.goto(BASE + "/#/place/auschwitz-oswiecim-poland", { waitUntil: "networkidle2" });
    await page.waitForSelector(".topbar:not([hidden])", { timeout: 5000 });
    await page.waitForSelector("#panel .card", { timeout: 5000 });
  });

  await browser.close();

  if (errors.length) {
    console.log("\n=== ERRORS (" + errors.length + ") ===");
    errors.forEach((e) => console.log(" - " + e));
    process.exit(1);
  }
  console.log("\nALL SMOKE CHECKS PASSED");
})();
