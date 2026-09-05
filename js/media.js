const SOURCE_HOSTS = new Set(["ohp.crestwood.on.ca", "crestwood.on.ca", "www.crestwood.on.ca"]);
const VIDEO_HOSTS = new Set(["vimeo.com", "www.vimeo.com", "player.vimeo.com"]);
const PLAYER_HOSTS = new Set(["player.vimeo.com"]);

function mediaURL(value, hosts, local = false) {
  if (!value) return null;
  if (typeof value !== "string") {
    console.warn("An archive media URL was not text.");
    return null;
  }
  if (local && /^assets\/portraits\/[a-z0-9_-]+\.webp$/i.test(value)) return value;
  let url;
  try {
    url = new URL(value);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.warn("An archive media URL was invalid.");
    return null;
  }
  if (url.protocol === "http:" && hosts.has(url.hostname)) url.protocol = "https:";
  if (url.protocol !== "https:" || !hosts.has(url.hostname) || url.username || url.password) {
    console.warn("An unsupported archive media URL was omitted.");
    return null;
  }
  return url.href;
}

export function normalizeProfileMedia(source = {}) {
  if (source == null) source = {};
  if (typeof source !== "object") {
    console.warn("An archive media inventory was invalid.");
    return { images: [], imageReferences: [], videos: [] };
  }
  const seenImages = new Set();
  const imageReferences = [];
  const images = (Array.isArray(source.images) ? source.images : []).flatMap((image) => {
    if (!image || typeof image !== "object") {
      console.warn("An archive gallery entry was invalid.");
      return [];
    }
    const url = mediaURL(image.url, SOURCE_HOSTS, true);
    if (!url || seenImages.has(url)) return [];
    seenImages.add(url);
    const reference = {
      url,
      sourceUrl: mediaURL(image.source_url, SOURCE_HOSTS),
      fullUrl: mediaURL(image.full_url, SOURCE_HOSTS),
      caption: String(image.caption || ""),
      credit: String(image.credit || "Crestwood Oral History Project"),
      primary: Boolean(image.primary),
    };
    if (!/\b(cleared|licensed|public domain|permission granted)\b/i.test(image.rights || "")) {
      imageReferences.push(reference);
      return [];
    }
    return [reference];
  });
  const seenVideos = new Set();
  const videos = (Array.isArray(source.videos) ? source.videos : []).flatMap((video) => {
    if (!video || typeof video !== "object") {
      console.warn("An interview inventory entry was invalid.");
      return [];
    }
    const id = String(video.id || "");
    if (!/^\d+$/.test(id) || seenVideos.has(id)) return [];
    const url = mediaURL(video.url, VIDEO_HOSTS);
    const embedUrl = mediaURL(video.embed_url, PLAYER_HOSTS);
    if (!url && !embedUrl) return [];
    seenVideos.add(id);
    return [{
      id,
      url: url || `https://vimeo.com/${id}`,
      embedUrl,
      title: String(video.title || `Interview chapter ${seenVideos.size}`),
      status: String(video.status || "pending"),
      language: String(video.language || ""),
    }];
  });
  return { images, imageReferences, videos };
}

export function playerURL(video) {
  if (!video.embedUrl || video.status === "unavailable") return null;
  const url = new URL(video.embedUrl);
  if (!/^\/video\/\d+\/?$/.test(url.pathname)) {
    console.warn("An unsupported Vimeo embed path was omitted.");
    return null;
  }
  const player = new URL(`https://player.vimeo.com${url.pathname}`);
  if (url.searchParams.has("h")) player.searchParams.set("h", url.searchParams.get("h"));
  player.searchParams.set("dnt", "1");
  player.searchParams.set("autoplay", "1");
  return player.href;
}

export function captionStatus(video) {
  switch (video.status) {
    case "captioned": return "Public captions are available.";
    case "no-public-captions": return "Vimeo does not provide public captions for this chapter.";
    case "unavailable": return "Inline playback is unavailable. Open the original OHP page.";
    case "caption-track-unavailable": return "Vimeo lists captions, but the caption file was unavailable.";
    default: return "Caption availability has not been confirmed.";
  }
}
