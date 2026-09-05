const BASE = "https://ohp.crestwood.on.ca";
const EMBED_PARAMETERS = new Set([
  "h", "title", "byline", "portrait", "color", "badge", "autopause", "dnt",
]);
const VIDEO_STATUSES = new Set([
  "captioned", "no-public-captions", "unavailable",
  "caption-track-unavailable", "pending", "error",
]);
const DECORATIVE = /(?:^|[/_.\s-])(?:logo|favicon|spinner|placeholder|background|banner|icon|loading)(?:[/_.\s-]|$)/i;
const GENERIC_TITLE = /^(?:\d+[.\s-]*)?(?:vimeo(?: video player)?|video|play|watch|watch video|click (?:here|to watch))$/i;

export function decodeEntities(value) {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
    hellip: "…", copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»",
  };
  return String(value || "").replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (match, entity) => {
      if (entity[0] !== "#") return named[entity.toLowerCase()] || match;
      const number = entity[1].toLowerCase() === "x"
        ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : match;
    },
  );
}

function clean(value) {
  return decodeEntities(String(value || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}=["']([^"']*)["']`, "i"));
  return match ? decodeEntities(match[1]) : "";
}

function parsedUrl(value, base) {
  const text = decodeEntities(value).trim();
  try {
    return new URL(text, base);
  } catch (error) {
    if (error instanceof TypeError) return null;
    throw error;
  }
}

function decodedComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}

export function safeVimeoReference(value, base = BASE) {
  const parsed = parsedUrl(value, base);
  if (
    !parsed ||
    !["http:", "https:"].includes(parsed.protocol) ||
    !["player.vimeo.com", "vimeo.com", "www.vimeo.com"].includes(parsed.hostname) ||
    parsed.username || parsed.password || parsed.port ||
    decodedComponent(parsed.pathname + parsed.search + parsed.hash) === null
  ) return null;
  const pattern = parsed.hostname === "player.vimeo.com"
    ? /^\/video\/(\d+)(?:\/([a-fA-F0-9]{6,64}))?\/?$/
    : /^\/(\d+)(?:\/([a-fA-F0-9]{6,64}))?\/?$/;
  const match = parsed.pathname.match(pattern);
  if (!match) return null;
  const parameters = new Map();
  for (const [key, item] of parsed.searchParams) {
    if (!EMBED_PARAMETERS.has(key)) continue;
    const valid = key === "h" ? /^[a-zA-Z0-9]{6,64}$/ : /^[a-zA-Z0-9_-]{1,32}$/;
    if (key === "h" && (!valid.test(item) || (parameters.has(key) && parameters.get(key) !== item))) return null;
    if (valid.test(item)) parameters.set(key, item);
  }
  if (match[2] && !parameters.has("h")) parameters.set("h", match[2]);
  const query = new URLSearchParams([...parameters].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)).toString();
  const embed = `https://player.vimeo.com/video/${match[1]}${query ? `?${query}` : ""}`;
  return { id: match[1], url: embed, embed_url: embed };
}

function accessReference(video) {
  const reference = safeVimeoReference(video?.embed_url);
  if (!reference) return "";
  return `${reference.id}|${new URL(reference.embed_url).searchParams.get("h") || ""}`;
}

function safePhotoUrl(value, base = BASE) {
  const parsed = parsedUrl(value, base);
  if (!parsed) return null;
  const decoded = decodedComponent(parsed.pathname);
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.hostname !== "ohp.crestwood.on.ca" ||
    parsed.username || parsed.password || parsed.port ||
    !parsed.pathname.startsWith("/wp-content/uploads/") ||
    !/\.(?:jpe?g|png|webp|gif|avif)$/i.test(parsed.pathname) ||
    decoded === null || decoded.includes("\\") ||
    decoded.split("/").some((part) => part === "." || part === "..") ||
    decodedComponent(parsed.search + parsed.hash) === null ||
    DECORATIVE.test(parsed.pathname)
  ) return null;
  return `https://${parsed.hostname}${parsed.pathname}`;
}

function photoKey(value) {
  const parsed = parsedUrl(value, BASE);
  if (!parsed) return null;
  const decoded = decodedComponent(parsed.pathname);
  return decoded === null ? null : decoded.replace(/-\d+x\d+(?=\.[^.]+$)/, "");
}

export function videoInventory(videoIds) {
  return fingerprint([...new Set(videoIds)].sort());
}

export function sourceInventory(videos) {
  return fingerprint(videos.map((video) => `${video.id}|${video.embed_url}`).sort());
}

function fingerprint(values) {
  let hash = 2166136261;
  for (const character of values.join(",")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `${values.length}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function entryContent(html) {
  return html.match(
    /class=["'][^"']*\bentry-content\b[^"']*["'][^>]*>([\s\S]*?)(?:<\/article>|<!--\s*\.entry-content\s*-->|$)/i,
  )?.[1] || "";
}

export function sourceBiography(html) {
  if (/(?:post-password-form|name=["']post_password["'])/i.test(html)) return "";
  return clean(entryContent(html)
    .split(/<(?:div|section)\b[^>]*\bid=["']ohp-(?:video|photo)["']/i)[0]
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " "));
}

export function parseProfileMedia(html, archiveUrl, name = "") {
  if (/(?:post-password-form|name=["']post_password["'])/i.test(html)) {
    return { images: [], videos: [] };
  }
  const content = entryContent(html);
  const videos = new Map();
  for (const match of content.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>|<iframe\b([^>]*)>/gi)) {
    const reference = safeVimeoReference(
      match[1] !== undefined
        ? attribute(match[1], "href")
        : attribute(match[3], "src") || attribute(match[3], "data-src"),
      archiveUrl,
    );
    if (!reference) continue;
    let title = clean(match[1] !== undefined ? match[2] : attribute(match[3], "title"));
    if (GENERIC_TITLE.test(title)) title = "";
    const prior = videos.get(reference.id);
    if (prior) {
      if (new URL(reference.embed_url).searchParams.has("h") && !new URL(prior.embed_url).searchParams.has("h")) {
        Object.assign(prior, reference);
      }
      if (/^Interview chapter \d+$/.test(prior.title) && title) prior.title = title;
      continue;
    }
    videos.set(reference.id, {
      ...reference, title: title || `Interview chapter ${videos.size + 1}`, status: "pending",
    });
  }
  const images = new Map();
  for (const match of content.matchAll(/<img\b[^>]*>/gi)) {
    const tag = match[0];
    const thumbnail = safePhotoUrl(attribute(tag, "data-src") || attribute(tag, "src"), archiveUrl);
    if (!thumbnail || DECORATIVE.test(`${attribute(tag, "class")} ${attribute(tag, "alt")}`)) continue;
    const prefix = content.slice(0, match.index);
    const anchors = [...prefix.matchAll(/<a\b[^>]*>|<\/a\s*>/gi)];
    const anchor = anchors.length && !/^<\/a/i.test(anchors[anchors.length - 1][0])
      ? anchors[anchors.length - 1][0] : "";
    const original = safePhotoUrl(attribute(anchor, "href"), archiveUrl);
    const source = original || thumbnail;
    const key = photoKey(source);
    if (images.has(key)) {
      if (original && !/-\d+x\d+(?=\.[^.]+$)/.test(new URL(original).pathname)) images.get(key).full_url = original;
      continue;
    }
    const figureStart = prefix.lastIndexOf("<figure");
    const figure = figureStart > prefix.lastIndexOf("</figure")
      ? content.slice(figureStart).split(/<\/figure\s*>/i)[0] : "";
    const figcaption = figure.match(/<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/i)?.[1];
    const caption = clean(figcaption || attribute(tag, "alt") || attribute(anchor, "title"));
    const image = {
      url: source, source_url: source,
      caption: caption || (name ? `Photograph from ${name}'s OHP archive.` : "OHP archive photograph."),
      credit: "Crestwood Oral History Project",
      rights: "See the OHP source page for photograph credits and reuse rights.",
    };
    if (original && !/-\d+x\d+(?=\.[^.]+$)/.test(new URL(original).pathname)) {
      image.full_url = original;
    }
    images.set(key, image);
  }
  return { images: [...images.values()], videos: [...videos.values()] };
}

function clearedPrimary(images) {
  return images.find((image) => (
    image.primary && /^assets\/portraits\/[a-z0-9-]+\.webp$/.test(image.url) &&
    image.rights && safePhotoUrl(image.source_url)
  ));
}

export function mergeProfileMedia(existing = {}, fresh = {}) {
  const oldVideos = new Map((existing.videos || []).map((video) => [video.id, video]));
  const videos = (fresh.videos || existing.videos || []).flatMap((video) => {
    const reference = safeVimeoReference(video.embed_url);
    if (!reference) return [];
    const prior = oldVideos.get(reference.id);
    const compatible = accessReference(prior) === accessReference(reference);
    const checked = video.status !== "pending" ? video : (compatible ? prior : video);
    const result = {
      ...reference,
      title: /^Interview chapter \d+$/.test(video.title) && compatible && prior.title
        ? prior.title : (video.title || `Interview chapter ${oldVideos.size + 1}`),
      status: VIDEO_STATUSES.has(checked?.status) ? checked.status : "pending",
    };
    if (checked?.language) result.language = checked.language;
    return [result];
  });
  const selected = clearedPrimary([...(fresh.images || []), ...(existing.images || [])]);
  let primary = null;
  if (selected) {
    const { full_url: priorFull, ...cleared } = selected;
    const key = photoKey(cleared.source_url);
    const matching = (fresh.images || []).find((image) => (
      safePhotoUrl(image.source_url) && photoKey(image.source_url) === key
    ));
    const fullUrl = matching?.full_url || priorFull;
    primary = { ...cleared, source_url: matching?.source_url || cleared.source_url };
    if (safePhotoUrl(fullUrl) && photoKey(fullUrl) === key) primary.full_url = fullUrl;
  }
  const images = new Map();
  for (const image of [...(primary ? [primary] : []), ...(fresh.images || existing.images || [])]) {
    const source = safePhotoUrl(image.source_url);
    if (!source) continue;
    const key = photoKey(source);
    const { full_url: fullUrl, ...record } = image;
    record.source_url = source;
    if (image === primary && fullUrl) record.full_url = fullUrl;
    if (!images.has(key)) images.set(key, record);
  }
  return { images: [...images.values()], videos };
}

export function mergeSeedMediaCoverage(existing = {}, seed = {}) {
  if (!existing.profile_media) return mergeMediaCoverage(existing, seed);
  const primary = clearedPrimary(seed.profile_media?.images || []);
  const current = {
    ...existing,
    profile_media: {
      ...existing.profile_media,
      images: primary
        ? [primary, ...(existing.profile_media.images || []).filter((image) => !image.primary)]
        : (existing.profile_media.images || []),
    },
  };
  // Live references define membership; the seed can supplement matching audits.
  return mergeMediaCoverage(seed, current);
}

function coverage(videos) {
  const captioned = videos.filter((video) => video.status === "captioned").length;
  const pending = videos.some((video) => ["pending", "error"].includes(video.status));
  const available = videos.some((video) => (
    ["captioned", "no-public-captions", "caption-track-unavailable"].includes(video.status)
  ));
  return {
    video_count: videos.length,
    video_inventory: videoInventory(videos.map((video) => video.id)),
    video_source_inventory: sourceInventory(videos),
    captioned_video_count: captioned,
    transcript_status: pending ? "pending" : (
      captioned === videos.length && captioned ? "complete" : (
        captioned ? "partial" : (available || !videos.length ? "none" : "unavailable")
      )
    ),
  };
}

export function mergeMediaCoverage(existing = {}, fresh = {}) {
  if (fresh.profile_media || existing.profile_media) {
    const profileMedia = mergeProfileMedia(existing.profile_media, fresh.profile_media);
    return { ...coverage(profileMedia.videos), profile_media: profileMedia };
  }
  const videoCount = fresh.video_count || 0;
  const inventoryChanged = (
    existing.video_inventory !== fresh.video_inventory ||
    (fresh.video_source_inventory && existing.video_source_inventory !== fresh.video_source_inventory)
  );
  return {
    video_count: videoCount,
    video_inventory: fresh.video_inventory,
    video_source_inventory: fresh.video_source_inventory,
    captioned_video_count: inventoryChanged ? 0 : Math.min(
      existing.captioned_video_count || 0, videoCount,
    ),
    transcript_status: inventoryChanged
      ? (videoCount ? "pending" : "none")
      : (existing.transcript_status || fresh.transcript_status || "none"),
  };
}
