const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { execFileSync } = require("node:child_process");
const { gzipSync } = require("node:zlib");

const ROOT = path.resolve(__dirname, "..");
const helpers = Promise.all([
  import(pathToFileURL(path.join(ROOT, "worker", "publication.js")).href),
  import(pathToFileURL(path.join(ROOT, "worker", "profile-pages.js")).href),
  import(pathToFileURL(path.join(ROOT, "worker", "collection-pages.js")).href),
]);

function write(out, name, body) {
  const destination = path.join(out, ...name.replace(/^\//, "").split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body);
}

function priorArchives(root) {
  // Keep the preceding committed seed versions addressable across clean deployments,
  // not just across hourly KV publications. A shallow checkout may have less history.
  try {
    const commits = execFileSync("git", ["log", "-3", "--format=%H", "--", "data/survivors.geojson"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim().split(/\s+/).filter(Boolean);
    return commits.map((commit) => JSON.parse(execFileSync("git", ["show", `${commit}:data/survivors.geojson`], {
      cwd: root, encoding: "utf8", maxBuffer: 40 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    })));
  } catch (error) {
    console.warn(`Previous seed details could not be retained: ${error.message.split("\n")[0]}`);
    return [];
  }
}

async function buildArchiveAssets({
  root = ROOT, out = path.join(root, "public"), doc, shell,
  sourceProfiles, origin, previousDocuments = [], releaseHash = null,
} = {}) {
  const [publication, pages, collection] = await helpers;
  const sourceBody = doc ? JSON.stringify(doc) : fs.readFileSync(path.join(root, "data", "survivors.geojson"), "utf8");
  doc ||= JSON.parse(sourceBody);
  shell ??= fs.readFileSync(path.join(root, "index.html"), "utf8");
  if (sourceProfiles === undefined) {
    const sourceFile = path.join(root, "data", "source", "ohp_profile_media.json");
    sourceProfiles = fs.existsSync(sourceFile) ? JSON.parse(fs.readFileSync(sourceFile, "utf8")).profiles : {};
  }
  const base = publication.siteOrigin(origin || process.env.SITE_ORIGIN);
  const fullBody = JSON.stringify(doc);
  const version = await publication.contentHash(publication.stableJSON(doc));
  let detailBytes = 0;
  const { index, catalog } = await publication.prepareArchive(doc, version, async ({ id, hash, body, feature }) => {
    write(out, publication.profilePath(id, hash), body);
    detailBytes += Buffer.byteLength(body);
    const properties = feature.properties;
    const source = [id, ...(properties.source_aliases || [])]
      .map((key) => sourceProfiles[key]).find((record) => record?.source_status === "public");
    const biography = source?.quote_text ?? properties.source_biography;
    const hasBiography = typeof biography === "string" && biography.trim().length > 0;
    const text = hasBiography ? biography : properties.bio_excerpt || "";
    write(out, `/data/biographies/${id}.json`, JSON.stringify({
      excerpt: properties.bio_excerpt || "", text, source_url: properties.archive_url || "",
      kind: hasBiography ? "source_biography" : "excerpt",
    }));
    write(out, `/data/profile-pages/${id}.${hash}.html`,
      pages.renderProfileHtml(shell, feature, { origin: base, sourceText: text }));
    write(out, `/data/profile-pages/${id}.${hash}.source.html`,
      pages.renderProfileHtml(shell, feature, { origin: base, sourceText: text, sourceOnly: true }));
  });
  let retained = 0;
  for (const previous of previousDocuments) {
    for (const feature of previous.features || []) {
      const id = feature.properties?.survivor_id;
      if (!Object.hasOwn(catalog.profiles, id)) continue;
      const body = publication.stableJSON(feature);
      const hash = await publication.contentHash(body);
      const name = publication.profilePath(id, hash);
      if (!fs.existsSync(path.join(out, ...name.slice(1).split("/")))) {
        write(out, name, body);
        retained++;
      }
    }
  }
  const body = JSON.stringify(index);
  write(out, "/data/index.json", body);
  write(out, collection.SOURCE_CATALOGUE_PATH, JSON.stringify(collection.buildSourceCatalogue(doc.features, releaseHash)));
  write(out, publication.SEED_CATALOG_PATH, JSON.stringify(catalog));
  write(out, "/sitemap.xml", publication.renderSitemap(catalog, base));
  write(out, "/robots.txt", `User-agent: *\nAllow: /\nDisallow: /data/\nSitemap: ${base}/sitemap.xml\n`);
  write(out, "/404.html", pages.renderErrorHtml());
  write(out, "/server-profile.css", fs.readFileSync(path.join(ROOT, "worker", "server-profile.css")));
  const stats = {
    profiles: index.features.length,
    aliases: Object.keys(catalog.aliases).length,
    index_bytes: Buffer.byteLength(body),
    index_gzip_bytes: gzipSync(body).length,
    full_bytes: Buffer.byteLength(fullBody),
    full_gzip_bytes: gzipSync(fullBody).length,
    source_file_bytes: Buffer.byteLength(sourceBody),
    detail_bytes: detailBytes,
    retained_details: retained,
  };
  if (stats.index_bytes > 3_000_000 || stats.index_gzip_bytes > 350_000) {
    throw new Error(`Compact archive exceeds its transfer budget: ${JSON.stringify(stats)}`);
  }
  return stats;
}

module.exports = { buildArchiveAssets, priorArchives };
