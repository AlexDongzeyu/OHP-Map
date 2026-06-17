const p = require("puppeteer-core");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:8124";
(async () => {
  const b = await p.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1366, height: 850 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await pg.waitForSelector("#topbar:not([hidden])", { timeout: 15000 });
  await wait(2600);
  await pg.screenshot({ path: "tools/shot-landing.png" });

  await pg.click(".landing-card [data-act='follow']"); await wait(2200);
  await pg.screenshot({ path: "tools/shot-guided.png" });

  await pg.click(".nav-tab[data-view='explore']"); await wait(900);
  await pg.click(".rail .rail-card"); await wait(2000);
  await pg.screenshot({ path: "tools/shot-explore.png" });

  await pg.click(".nav-tab[data-view='patterns']"); await wait(1200);
  await pg.$eval(".scrubber .range", (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(1200);
  await pg.screenshot({ path: "tools/shot-patterns.png" });

  await pg.setViewport({ width: 390, height: 800 });
  await pg.goto(BASE + "/#/explore", { waitUntil: "networkidle2" }); await wait(1800);
  await pg.screenshot({ path: "tools/shot-mobile.png" });

  await b.close();
  console.log("screenshots written");
})();
