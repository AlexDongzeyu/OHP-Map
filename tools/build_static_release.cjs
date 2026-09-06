const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { pathToFileURL } = require("node:url");

const ROOT = path.resolve(__dirname, "..");
const STATIC_DIRECTORIES = ["js", "css", "assets", "vendor"];
const FORMAT = 1;
const REGISTRY = "releases.json";
const MANIFEST = "release-manifest.json";
const STATIC_ROOT_SENTINEL = 'const STATIC_ASSET_ROOT = "../";';
const SSR_STYLE = "css/server-profile.css";
const SHARED = path.join(ROOT, "worker", "static-assets.js");
const shared = import(pathToFileURL(SHARED).href);
const digest = (body) => createHash("sha256").update(body).digest("hex");
const isHash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function staticName(name, directory = false) {
  const parts = typeof name === "string" ? name.split("/") : [];
  return STATIC_DIRECTORIES.includes(parts[0]) && (directory || parts.length > 1) &&
    parts.every((part) => part && part !== "." && part !== ".." &&
      !/[\\\u0000-\u001f\u007f<>:"|?*%]/.test(part) && !/[. ]$/.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

function replaceStatement(body, from, to) {
  let matches = 0;
  const result = body.toString("utf8").split("\n").map((line) => {
    const cr = line.endsWith("\r") ? "\r" : "";
    if ((cr ? line.slice(0, -1) : line) !== from) return line;
    matches++;
    return to + cr;
  }).join("\n");
  if (matches !== 1) throw new Error("js/config.js must contain exactly one standalone STATIC_ASSET_ROOT sentinel");
  return Buffer.from(result);
}

function rootStatement(hash) {
  return `const STATIC_ASSET_ROOT = "/releases/${hash}/";`;
}

function treeHash(builder, directories, files) {
  return digest(JSON.stringify([FORMAT, builder, directories, files.map((file) => [file.path, file.source_sha256])]));
}

function validateManifest(manifest, hash) {
  if (!manifest || manifest.format !== FORMAT || manifest.hash !== hash || !isHash(hash) || !isHash(manifest.builder) ||
    !Array.isArray(manifest.files) || manifest.files.length > 20_000 ||
    !Array.isArray(manifest.directories) || manifest.directories.length > 20_000 ||
    !manifest.directories.every((name) => staticName(name, true)) ||
    manifest.files.some((file) => !file || !staticName(file.path) || !isHash(file.source_sha256) || !isHash(file.sha256)) ||
    new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length ||
    treeHash(manifest.builder, manifest.directories, manifest.files) !== hash) {
    throw new Error("Invalid retained static release manifest");
  }
  const directories = new Set(manifest.directories);
  for (const file of manifest.files) {
    if (directories.has(file.path)) throw new Error("Static release file conflicts with a directory");
    const parts = file.path.split("/");
    for (let count = 1; count < parts.length; count++) {
      if (!directories.has(parts.slice(0, count).join("/"))) throw new Error("Static release is missing a parent directory");
    }
  }
  if (process.platform === "win32") {
    const names = [...manifest.directories, ...manifest.files.map((file) => file.path)];
    if (new Set(names.map((name) => name.toLowerCase())).size !== names.length) {
      throw new Error("Static release has case-colliding paths on this filesystem");
    }
  }
}

function verifyReleaseFile(file, body, hash) {
  const source = file.path === "js/config.js" ? replaceStatement(body, rootStatement(hash), STATIC_ROOT_SENTINEL) : body;
  if (digest(body) !== file.sha256 || digest(source) !== file.source_sha256) {
    throw new Error(`Retained static release was modified: ${file.path}`);
  }
}

function validateRegistry(document) {
  if (!document || document.format !== FORMAT || !isHash(document.current) ||
    (document.previous !== null && !isHash(document.previous))) throw new Error("Invalid static release registry");
  return document;
}

function write(out, name, body) {
  const destination = path.join(out, ...name.split("/"));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, body);
}

function walkFiles(directory, visit, relative = "", visitDirectory = () => {}) {
  for (const item of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
    const full = path.join(directory, item.name);
    const name = relative ? `${relative}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw new Error(`Static trees cannot contain symbolic links: ${name}`);
    if (item.isDirectory()) {
      visitDirectory(name);
      walkFiles(full, visit, name, visitDirectory);
    }
    else if (item.isFile()) visit(full, name);
    else throw new Error(`Unsupported static file: ${name}`);
  }
}

function assertOutput(root, out) {
  const relative = path.relative(root, out);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative) ||
    STATIC_DIRECTORIES.includes(relative.split(path.sep)[0].toLowerCase())) {
    throw new Error("Static output must be a separate directory inside the project, outside the source trees");
  }
  let ancestor = root;
  for (const segment of relative.split(path.sep)) {
    ancestor = path.join(ancestor, segment);
    if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error("Static output cannot contain symbolic links");
  }
}

function prepareStaticRelease(root = ROOT) {
  root = path.resolve(root);
  const sources = [];
  const directories = new Set(STATIC_DIRECTORIES);
  for (const directory of STATIC_DIRECTORIES) {
    const input = path.join(root, directory);
    if (!fs.existsSync(input) || !fs.lstatSync(input).isDirectory() || fs.lstatSync(input).isSymbolicLink()) {
      throw new Error(`Missing or invalid static input directory: ${directory}`);
    }
    walkFiles(input, (full, name) => sources.push({ path: `${directory}/${name}`, source: fs.readFileSync(full) }),
      "", (name) => directories.add(`${directory}/${name}`));
  }
  if (sources.some((file) => file.path === SSR_STYLE)) throw new Error(`${SSR_STYLE} is reserved for the generated profile stylesheet`);
  const profileStyle = path.join(root, "worker", "server-profile.css");
  if (!fs.lstatSync(profileStyle).isFile() || fs.lstatSync(profileStyle).isSymbolicLink()) {
    throw new Error("The profile stylesheet must be a regular source file");
  }
  sources.push({ path: SSR_STYLE, source: fs.readFileSync(profileStyle) });
  sources.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!sources.some((file) => file.path === "js/config.js")) throw new Error("Missing static input js/config.js");
  for (const file of sources) {
    if (!staticName(file.path)) throw new Error(`Unsafe static path: ${file.path}`);
    const parts = file.path.split("/");
    for (let length = 1; length < parts.length; length++) directories.add(parts.slice(0, length).join("/"));
    file.source_sha256 = digest(file.source);
  }
  const orderedDirectories = [...directories].sort();
  // The transform implementation participates in the identity too: changing the
  // sentinel transform must never mutate bytes behind an existing release URL.
  const builder = digest(Buffer.concat([fs.readFileSync(__filename), fs.readFileSync(SHARED)]));
  const hash = treeHash(builder, orderedDirectories, sources);
  const files = sources.map((file) => {
    const body = file.path === "js/config.js" ? replaceStatement(file.source, STATIC_ROOT_SENTINEL, rootStatement(hash)) : file.source;
    return { ...file, body, sha256: digest(body) };
  });
  const manifest = {
    format: FORMAT, hash, builder, directories: orderedDirectories,
    files: files.map(({ path, source_sha256, sha256 }) => ({ path, source_sha256, sha256 })),
  };
  return { hash, files, manifest };
}

function readRelease(out, hash) {
  if (!isHash(hash)) throw new Error("Invalid retained release hash");
  const directory = path.join(out, "releases", hash);
  if (!fs.existsSync(directory)) return null;
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("A retained release cannot be a symbolic link");
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, MANIFEST), "utf8"));
  validateManifest(manifest, hash);
  const found = new Map();
  walkFiles(directory, (full, name) => found.set(name, full));
  if (found.size !== manifest.files.length + 1 || new Set(manifest.files.map((file) => file.path)).size !== manifest.files.length) {
    throw new Error("Retained release files do not match their manifest");
  }
  const files = manifest.files.map((file) => {
    if (!found.has(file.path)) throw new Error(`Missing retained static file: ${file.path}`);
    const body = fs.readFileSync(found.get(file.path));
    verifyReleaseFile(file, body, hash);
    return { ...file, body };
  });
  return { hash, files, manifest };
}

function captureStaticReleases(out) {
  const registry = path.join(out, REGISTRY);
  if (!fs.existsSync(registry)) return [];
  const document = validateRegistry(JSON.parse(fs.readFileSync(registry, "utf8")));
  return [...new Set([document.current, document.previous].filter(Boolean))]
    .map((hash) => readRelease(out, hash)).filter(Boolean);
}

async function restorePublishedReleases({
  origin = process.env.OHP_PUBLISHED_ORIGIN || process.env.SITE_ORIGIN || "https://ohpmap.alexdong0414.workers.dev",
  prepared, fetcher = globalThis.fetch, timeoutMs = 30_000,
} = {}) {
  const base = new URL(origin);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if ((base.protocol !== "https:" && !(base.protocol === "http:" && loopback)) ||
    base.username || base.password || base.pathname !== "/" || base.search || base.hash) {
    throw new Error("Published release origin must be an HTTPS origin (HTTP is only allowed for local tests)");
  }
  const MAX_TOTAL = 512 * 1024 * 1024;
  let transferred = 0;
  async function readPublished(pathname, limit, allowMissing = false) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(new URL(pathname, base).href, {
        method: "GET", redirect: "error", signal: controller.signal,
        headers: { "cache-control": "no-cache", "accept-encoding": "identity" },
      });
      if (allowMissing && response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (response.status !== 200 || Number(response.headers.get("content-length") || 0) > limit) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status} or oversized response`);
      }
      const chunks = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            transferred += value.byteLength;
            if (size > limit || transferred > MAX_TOTAL) throw new Error("Published release exceeds restore byte limits");
            chunks.push(Buffer.from(value));
          }
        } catch (error) {
          await reader.cancel();
          throw error;
        }
      }
      return Buffer.concat(chunks);
    } catch (error) {
      throw new Error(`Cannot restore published release ${pathname}: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
  async function registry(allowMissing = false) {
    const body = await readPublished(`/${REGISTRY}`, 4096, allowMissing);
    return body === null ? null : validateRegistry(JSON.parse(body.toString("utf8")));
  }

  const published = await registry(true);
  if (!published) {
    const html = (await readPublished("/", 1024 * 1024)).toString("utf8");
    const { staticReleaseFromHtml } = await shared;
    // A real legacy application without release URLs is a first hashed deploy.
    // Errors, missing registries on a hashed site, and unrecognized pages are not.
    if (staticReleaseFromHtml(html) || /\/releases\/[a-f0-9]{64}\//i.test(html) ||
      !/<script\b[^>]*\bsrc=["'](?:\.\/|\/)?js\/app\.js(?:\?[^"']*)?["']/i.test(html)) {
      throw new Error("Published release registry is missing on a hashed or unrecognized site");
    }
    if (await registry(true)) throw new Error("Published release changed during restoration; retry the build");
    return { releases: [], requiredHash: null, publishedHash: null, firstRelease: true, origin: base.origin };
  }

  // On an unchanged redeploy keep the preceding release, not a duplicate of the
  // current tree. Never substitute an unpublished local/CRLF hash for this target.
  const target = published.current === prepared?.hash ? published.previous : published.current;
  let restored = null;
  if (target) {
    const manifest = JSON.parse((await readPublished(`/releases/${target}/${MANIFEST}`, 8 * 1024 * 1024)).toString("utf8"));
    validateManifest(manifest, target);
    const local = new Map((prepared?.files || []).map((file) => [file.path, file]));
    const files = new Array(manifest.files.length);
    let cursor = 0;
    let totalBytes = 0;
    let failed = null;
    await Promise.all(Array.from({ length: Math.min(6, manifest.files.length) }, async () => {
      while (!failed && cursor < manifest.files.length) {
        const index = cursor++;
        const file = manifest.files[index];
        try {
          const candidate = local.get(file.path);
          let body;
          if (candidate?.source_sha256 === file.source_sha256) {
            body = file.path === "js/config.js"
              ? replaceStatement(candidate.source, STATIC_ROOT_SENTINEL, rootStatement(target)) : candidate.source;
          } else {
            const encoded = file.path.split("/").map(encodeURIComponent).join("/");
            body = await readPublished(`/releases/${target}/${encoded}`, 25 * 1024 * 1024);
          }
          verifyReleaseFile(file, body, target);
          totalBytes += body.length;
          if (totalBytes > MAX_TOTAL) throw new Error("Published release exceeds restore byte limits");
          files[index] = { ...file, body };
        } catch (error) {
          failed = error;
        }
      }
    }));
    if (failed) throw failed;
    restored = { hash: target, files, manifest };
  }
  const after = await registry();
  if (after.current !== published.current || after.previous !== published.previous) {
    throw new Error("Published release changed during restoration; retry the build");
  }
  return {
    releases: restored ? [restored] : [], requiredHash: target,
    publishedHash: published.current, firstRelease: false, origin: base.origin,
  };
}

function writeRelease(out, release) {
  const directory = path.join(out, "releases", release.hash);
  for (const name of release.manifest.directories) fs.mkdirSync(path.join(directory, ...name.split("/")), { recursive: true });
  for (const file of release.files) write(directory, file.path, file.body);
  write(directory, MANIFEST, JSON.stringify(release.manifest));
}

async function buildStaticRelease({
  root = ROOT, out = path.join(root, "public"), prepared, previous, requiredPreviousHash = null,
  origin = process.env.SITE_ORIGIN || "https://ohpmap.alexdong0414.workers.dev", maxAssets = 20_000,
} = {}) {
  root = path.resolve(root);
  out = path.resolve(out);
  if (!Number.isInteger(maxAssets) || maxAssets < 1 || maxAssets > 20_000) throw new Error("Asset limit must be between 1 and 20000");
  assertOutput(root, out);
  const release = prepared || prepareStaticRelease(root);
  previous ??= captureStaticReleases(out);
  let retained = previous.find((candidate) => candidate.hash !== release.hash) || null;
  if (requiredPreviousHash && requiredPreviousHash !== release.hash && retained?.hash !== requiredPreviousHash) {
    throw new Error("The required published static release has not been restored");
  }
  const owned = new Set([...STATIC_DIRECTORIES, "releases", REGISTRY, "server-profile.css"]);
  let otherFiles = 0;
  if (fs.existsSync(out)) walkFiles(out, (_full, name) => {
    if (!owned.has(name.split("/")[0])) otherFiles++;
  });
  const currentFiles = otherFiles + 2 * release.files.length + 3;
  if (currentFiles > maxAssets) throw new Error(`Static aliases and current archive require ${currentFiles} files; asset limit is ${maxAssets}`);
  if (retained && currentFiles + retained.files.length + 1 > maxAssets) {
    if (requiredPreviousHash) throw new Error(`The required published release cannot fit the ${maxAssets}-file asset limit`);
    retained = null;
  }

  fs.mkdirSync(out, { recursive: true });
  for (const directory of [...STATIC_DIRECTORIES, "releases"]) {
    fs.rmSync(path.join(out, directory), { recursive: true, force: true });
  }
  for (const directory of release.manifest.directories) fs.mkdirSync(path.join(out, ...directory.split("/")), { recursive: true });
  for (const file of release.files) write(out, file.path, file.source);
  write(out, "server-profile.css", release.files.find((file) => file.path === SSR_STYLE).source);
  writeRelease(out, release);
  if (retained) writeRelease(out, retained);
  write(out, REGISTRY, JSON.stringify({ format: FORMAT, current: release.hash, previous: retained?.hash || null }));

  const { rewriteStaticHtml, releasePrefix } = await shared;
  walkFiles(out, (full, name) => {
    if (!owned.has(name.split("/")[0]) && name.endsWith(".html")) {
      fs.writeFileSync(full, rewriteStaticHtml(fs.readFileSync(full, "utf8"), release.hash, origin));
    }
  });
  let totalFiles = 0;
  walkFiles(out, () => totalFiles++);
  if (totalFiles > maxAssets) throw new Error(`Static site exceeds the ${maxAssets}-file asset limit`);
  return {
    hash: release.hash, prefix: releasePrefix(release.hash),
    manifest_url: `${releasePrefix(release.hash)}${MANIFEST}`, registry_url: `/${REGISTRY}`,
    previous: retained?.hash || null,
    source_files: release.files.length, retained_releases: retained ? 2 : 1, total_files: totalFiles,
  };
}

module.exports = { buildStaticRelease, prepareStaticRelease, captureStaticReleases, restorePublishedReleases };
