export const STATIC_DIRECTORIES = ["js", "css", "assets", "vendor"];
export const RELEASE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const RELEASE_PATH = /^\/releases\/([a-f0-9]{64})\/(?:js|css|assets|vendor)\/(.+)$/;
const STATIC_PATH = /^(?:js|css|assets|vendor)\//;

export function releasePrefix(hash) {
  if (typeof hash !== "string" || !RELEASE_HASH_PATTERN.test(hash)) throw new Error("Invalid static release hash");
  return `/releases/${hash}/`;
}

export function isReleaseAssetPath(pathname) {
  const match = RELEASE_PATH.exec(pathname);
  if (!match) return false;
  return match[2].split("/").every((segment) => {
    try {
      const decoded = decodeURIComponent(segment);
      return decoded && decoded !== "." && decoded !== ".." && !/[\u0000-\u001f\u007f\\/%]/.test(decoded);
    } catch {
      return false;
    }
  });
}

export function isStaticAliasPath(pathname) {
  return pathname === "/server-profile.css" || STATIC_PATH.test(pathname.replace(/^\//, ""));
}

function attribute(tag, name) {
  return tag.match(new RegExp(`\\b${name}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2] || "";
}

export function staticReleaseFromHtml(html) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(match[0], "name") !== "ohp-static-release") continue;
    const hash = attribute(match[0], "content");
    if (RELEASE_HASH_PATTERN.test(hash)) return hash;
  }
  return null;
}

function localStaticPath(value, origin) {
  let local = value;
  if (/^https?:\/\//i.test(local)) {
    try {
      const url = new URL(local);
      if (!origin || url.origin !== new URL(origin).origin || url.username || url.password) return null;
      local = url.pathname + url.search + url.hash;
    } catch {
      return null;
    }
  } else if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(local)) {
    return null;
  }
  local = local.replace(/^\/releases\/[a-f0-9]{64}\//, "");
  local = local.replace(/^(?:\.\/|\/)/, "");
  if (/^server-profile\.css(?:[?#]|$)/.test(local)) local = "css/" + local;
  return STATIC_PATH.test(local) ? local : null;
}

export function rewriteStaticHtml(html, hash, origin) {
  if (!hash) return html;
  const prefix = releasePrefix(hash);
  // Rewrite HTML URLs only. Module specifiers, CSS contents and SVG fragments
  // are intentionally untouched; their complete directory trees move together.
  let result = html.replace(/\b(src|href)\s*=\s*(["'])([^"']*)\2/gi, (match, name, quote, value) => {
    const local = localStaticPath(value, origin);
    if (local) return `${name}=${quote}${prefix}${local}${quote}`;
    if (/^(?:\.\/)?data\//.test(value)) return `${name}=${quote}/${value.replace(/^\.\//, "")}${quote}`;
    return match;
  });
  let marked = false;
  result = result.replace(/<meta\b[^>]*>/gi, (tag) => {
    if (attribute(tag, "name") === "ohp-static-release") {
      if (marked) return "";
      marked = true;
      return `<meta name="ohp-static-release" content="${hash}" />`;
    }
    const kind = attribute(tag, "property") || attribute(tag, "name");
    if (!/^(?:og:image(?::(?:url|secure_url))?|twitter:image(?::src)?)$/i.test(kind)) return tag;
    return tag.replace(/\bcontent\s*=\s*(["'])([^"']*)\1/i, (match, quote, value) => {
      const local = localStaticPath(value, origin);
      if (!local) return match;
      const target = origin ? new URL(prefix + local, origin).href : prefix + local;
      return `content=${quote}${target}${quote}`;
    });
  });
  return marked ? result : result.replace(/<\/head\s*>/i, `  <meta name="ohp-static-release" content="${hash}" />\n</head>`);
}
