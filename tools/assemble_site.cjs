// Assemble a clean ./public directory containing ONLY the static site, so the
// Cloudflare Worker's assets binding never serves repo plumbing, tooling, or source.
// Also (re)builds the compact Europe basemap. wrangler runs this via [build].command.
const { execSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { buildArchiveAssets, priorArchives } = require("./build_archive_assets.cjs");
const { buildFlagRegistry } = require("./build_flag_registry.cjs");
const {
  buildStaticRelease, prepareStaticRelease, captureStaticReleases, restorePublishedReleases,
} = require("./build_static_release.cjs");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.join(ROOT, "public");

// Individual files.
const FILES = ["index.html", "embed.html"];
// Only the JSON the front end fetches at runtime.
const DATA = [
  "survivors.geojson",
  "place_index.json",
  "connections.json",
  "war_context.json",
  "historical_boundaries.json",
  "historical_boundary_index.json",
  "historical_boundary_quality.json",
  "atlas-europe.json",
  "atlas-world.json",
];

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function copy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(src, dest, { recursive: true });
}

async function assemble() {
  await buildFlagRegistry({ check: true });
  const staticRelease = prepareStaticRelease(ROOT);
  const published = process.argv.includes("--restore-published")
    ? await restorePublishedReleases({ prepared: staticRelease }) : null;
  const previousReleases = published ? published.releases : captureStaticReleases(OUT);
  if (published) {
    console.log(published.firstRelease ? "Verified first hashed release (published site is unversioned)."
      : `Verified published release ${published.publishedHash}; retaining ${published.requiredHash || "the unchanged current tree"}.`);
  }
  // Fail required restoration before modifying local output or generated data.
  execSync("node tools/build_atlas.cjs", { cwd: ROOT, stdio: "inherit" });
  rmrf(OUT);
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of FILES) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) copy(src, path.join(OUT, f));
  }
  for (const f of DATA) {
    const src = path.join(ROOT, "data", f);
    if (fs.existsSync(src)) copy(src, path.join(OUT, "data", f));
  }
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");
  const stats = await buildArchiveAssets({ root: ROOT, out: OUT, previousDocuments: priorArchives(ROOT) });
  const release = await buildStaticRelease({
    root: ROOT, out: OUT, prepared: staticRelease, previous: previousReleases,
    requiredPreviousHash: published?.requiredHash || null,
  });
  let count = 0;
  (function walk(p) {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) walk(full);
      else count++;
    }
  })(OUT);
  console.log(`Assembled public/ with ${count} files.`);
  console.log(`Compact archive: ${stats.profiles} profiles, ${stats.index_bytes} bytes / ${stats.index_gzip_bytes} gzip bytes.`);
  console.log(`Complete profile data: ${stats.detail_bytes} bytes; ${stats.retained_details} preceding seed details retained.`);
  console.log(`Static release ${release.hash}: ${release.retained_releases} retained tree(s), ${release.total_files} total files.`);
}

assemble().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
