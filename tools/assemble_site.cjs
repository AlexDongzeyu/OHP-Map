// Assemble a clean ./public directory containing ONLY the static site, so the
// Cloudflare Worker's assets binding never serves repo plumbing (.git, .github),
// tooling, or pipeline source. wrangler runs this via [build].command before deploy.
//
// Cross-platform (Node fs), no dependencies. Safe to run repeatedly.
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public");

// Whole directories copied verbatim.
const DIRS = ["css", "js", "vendor", "assets"];
// Individual files.
const FILES = ["index.html", "embed.html"];
// Only the three JSON artifacts the front end actually fetches at runtime.
const DATA = ["survivors.geojson", "place_index.json", "connections.json"];

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

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
for (const f of FILES) {
  const src = path.join(ROOT, f);
  if (fs.existsSync(src)) copy(src, path.join(OUT, f));
}
for (const f of DATA) {
  const src = path.join(ROOT, "data", f);
  if (fs.existsSync(src)) copy(src, path.join(OUT, "data", f));
}
// SPA niceties.
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
