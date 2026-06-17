// Assemble a clean ./public directory containing ONLY the static site, so the
// Cloudflare Worker's assets binding never serves repo plumbing, tooling, or source.
// Also (re)builds the compact Europe basemap. wrangler runs this via [build].command.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public");

// Build the compact basemap first (writes data/atlas-europe.json).
execSync("node tools/build_atlas.cjs", { cwd: ROOT, stdio: "inherit" });

// Whole directories copied verbatim.
const DIRS = ["css", "js", "assets"];
// Only the vendor libraries the runtime actually loads (D3 + fonts).
const VENDOR = ["vendor/d3", "vendor/fonts"];
// Individual files.
const FILES = ["index.html", "embed.html"];
// Only the JSON the front end fetches at runtime.
const DATA = ["survivors.geojson", "place_index.json", "connections.json", "atlas-europe.json"];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

rmrf(OUT);
fs.mkdirSync(OUT, { recursive: true });

for (const d of DIRS) {
  const src = path.join(ROOT, d);
  if (fs.existsSync(src)) copy(src, path.join(OUT, d));
}
for (const v of VENDOR) {
  const src = path.join(ROOT, v);
  if (fs.existsSync(src)) copy(src, path.join(OUT, v));
}
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) copy(src, path.join(OUT, f));
}
for (const f of DATA) {
  const src = path.join(ROOT, "data", f);
  if (fs.existsSync(src)) copy(src, path.join(OUT, "data", f));
}
fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

let count = 0;
(function walk(p) {
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) walk(full);
    else count++;
  }
})(OUT);
console.log(`Assembled public/ with ${count} files.`);
