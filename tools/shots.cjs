const p = require("puppeteer-core");
const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const BASE = "http://localhost:8124";
(async () => {
  const b = await p.launch({ executablePath: EDGE, headless: "new", args: ["--no-sandbox"] });
  const pg = await b.newPage();
  await pg.setViewport({ width: 1280, height: 800 });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Landing first (no hash → intro visible).
  await pg.goto(BASE + "/", { waitUntil: "networkidle2" });
  await wait(2600);
  await pg.screenshot({ path: "tools/shot-landing.png" });

  await pg.goto(BASE + "/#/guided", { waitUntil: "networkidle2" });
  await wait(2500);
  await pg.screenshot({ path: "tools/shot-guided.png" });

  await pg.click('.mode-tab[data-mode="explore"]'); await wait(800);
  await pg.click("#panel .result"); await wait(2500);
  await pg.screenshot({ path: "tools/shot-explore.png" });

  await pg.$eval('#scrubber input[type=range]', (el) => { el.value = "1944"; el.dispatchEvent(new Event("input", { bubbles: true })); });
  await wait(1200);
  await pg.screenshot({ path: "tools/shot-scrubber-1944.png" });

  await pg.click('.mode-tab[data-mode="patterns"]'); await wait(2500);
  await pg.screenshot({ path: "tools/shot-patterns.png" });

  await pg.setViewport({ width: 390, height: 780 });
  await pg.goto(BASE + "/#/explore", { waitUntil: "networkidle2" }); await wait(2000);
  await pg.screenshot({ path: "tools/shot-mobile.png" });

  await b.close();
  console.log("screenshots written");
})();
