import { DEFAULT_ORIGIN, siteOrigin, xmlEscape as esc } from "./publication.js";
import { rewriteStaticHtml, staticReleaseFromHtml } from "./static-assets.js";

export function rootAssetReferences(html) {
  return html.replace(/\b(src|href)=(["'])(?:\.\/)?((?:assets|css|js|vendor|data)\/[^"']*)\2/g,
    (_match, attribute, quote, value) => `${attribute}=${quote}/${value}${quote}`);
}

function publicSource(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname === "ohp.crestwood.on.ca" &&
      !url.username && !url.password && !url.port && !url.search && !url.hash
      ? url.href : null;
  } catch {
    return null;
  }
}

export function permittedPortrait(properties, origin = DEFAULT_ORIGIN) {
  if (/\b(?:no|not|without|denied|prohibited|unlicensed|all rights reserved)\b/i.test(properties.portrait_rights || "")) return null;
  if (!/\b(?:permission granted|public domain|CC[- ]BY(?:[- ]SA)?|CC0)\b/i.test(properties.portrait_rights || "")) return null;
  const value = properties.portrait;
  if (typeof value !== "string") return null;
  if (/^\/?assets\/portraits\/[a-z0-9_-]+\.(?:webp|png|jpe?g)$/i.test(value)) {
    return siteOrigin(origin) + "/" + value.replace(/^\//, "");
  }
  const source = publicSource(value);
  return source && /^https:\/\/ohp\.crestwood\.on\.ca\/wp-content\/uploads\/[^?#]+\.(?:webp|png|jpe?g)$/i.test(source)
    ? source : null;
}

function socialPortrait(properties, origin) {
  const portrait = permittedPortrait(properties, origin);
  if (!portrait) return null;
  const images = Array.isArray(properties.profile_media?.images) ? properties.profile_media.images : [];
  const primary = images.find(image => image.url === properties.portrait);
  const fullSize = primary && permittedPortrait({
    ...properties, portrait: primary.full_url || primary.source_url,
    portrait_rights: primary.rights || properties.portrait_rights,
  }, origin);
  // The local 192px reader thumbnails are below some social platforms' minimum.
  return fullSize || publicSource(properties.portrait);
}

function description(text, name) {
  const plain = String(text || "").replace(/\s+/g, " ").trim();
  if (!plain) return `${name}'s account and recorded place references in the Crestwood Oral History Project.`;
  return plain.length <= 180 ? plain : plain.slice(0, 177).replace(/\s+\S*$/, "") + "…";
}

function recordedPlaces(properties) {
  const waypoints = properties.waypoints || [];
  if (!waypoints.length) return "<p>No place references have been mapped for this account.</p>";
  return "<ul>" + waypoints.map((place) => {
    const dates = [place.date?.start, place.date?.end].filter(Boolean);
    const date = [...new Set(dates)].join("–");
    const written = place.as_written && place.as_written !== place.canonical
      ? ` <span>(recorded as “${esc(place.as_written)}”)</span>` : "";
    const review = place.verified ? "Human-checked reference" :
      place.evidence?.scope === "contextual" ? "Contextual reference; not a confirmed personal journey" :
        "Unreviewed reference";
    return `<li><strong>${esc(place.canonical || place.as_written || "Unnamed place")}</strong>${written}` +
      `${date ? ` · ${esc(date)}` : ""}<small>${esc(review)}</small></li>`;
  }).join("") + "</ul>";
}

export function renderProfileHtml(shell, feature, { origin = DEFAULT_ORIGIN, sourceText, sourceOnly = false } = {}) {
  const base = siteOrigin(origin);
  const properties = feature.properties;
  const name = properties.name || properties.survivor_id;
  const canonical = `${base}/survivor/${properties.survivor_id}`;
  const title = `${name} | Crestwood Oral History Project`;
  const biography = sourceText ?? properties.source_biography ?? properties.bio_excerpt ?? "";
  const summary = description(biography, name);
  const portrait = permittedPortrait(properties, base);
  const sharedPortrait = socialPortrait(properties, base);
  const image = sharedPortrait || `${base}/assets/social-preview.png`;
  const source = publicSource(properties.archive_url);
  const caveat = properties.review_status === "reviewed"
    ? "This map record is marked reviewed. Place coordinates remain approximations; consult the original account for its context."
    : "Map references have not been fully reviewed. Automatically matched names, dates and places may need correction; a place reference is not necessarily a personal journey.";
  const metadata = `
  <title>${esc(title)}</title>
  <link rel="canonical" href="${esc(canonical)}" />
  <meta name="description" content="${esc(summary)}" />
  <meta property="og:type" content="profile" />
  <meta property="og:title" content="${esc(title)}" />
  <meta property="og:description" content="${esc(summary)}" />
  <meta property="og:url" content="${esc(canonical)}" />
  <meta property="og:image" content="${esc(image)}" />
  <meta property="og:image:alt" content="${esc(sharedPortrait ? name : "Crestwood Oral History Project")}" />
  ${sharedPortrait ? "" : '<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />'}
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${esc(title)}" />
  <meta name="twitter:description" content="${esc(summary)}" />
  <meta name="twitter:image" content="${esc(image)}" />
  <meta name="twitter:image:alt" content="${esc(sharedPortrait ? name : "Crestwood Oral History Project")}" />
  <link rel="stylesheet" href="/server-profile.css" />`;
  const article = `
  <main id="server-profile" data-survivor-id="${esc(properties.survivor_id)}" aria-labelledby="server-profile-name">
    <div class="server-profile-inner">
      <nav aria-label="Archive navigation"><a href="/collection">Source catalogue</a> ${sourceOnly
        ? `<a href="/survivor/${esc(properties.survivor_id)}">Open interactive account</a>`
        : '<a href="/#/explore">Interactive collection</a>'}</nav>
      <p class="server-profile-kicker">Crestwood Oral History Project · ${esc(properties.group || "Recorded account")}</p>
      <h1 id="server-profile-name">${esc(name)}</h1>
      ${portrait ? `<figure><img src="${esc(portrait)}" alt="${esc(name)}" width="192" height="192" /><figcaption>${esc(properties.portrait_rights)}</figcaption></figure>` : ""}
      <p class="server-profile-caveat">${esc(caveat)}</p>
      ${sourceOnly ? "" : `<div class="server-profile-loading">
        <p data-server-profile-status role="status">The interactive account opens when the map finishes loading. This source summary remains available if it cannot load.</p>
        <button type="button" data-server-profile-retry hidden>Try the interactive view again</button>
      </div>`}
      ${sourceOnly ? "" : `<noscript><p class="server-profile-caveat server-profile-js-note">Selecting an interview chapter and playing its video require JavaScript.
        This source account remains readable; use its original OHP link for the interview.</p></noscript>`}
      <section aria-labelledby="server-source"><h2 id="server-source">From the original OHP biography</h2>
        ${biography ? `<blockquote${source ? ` cite="${esc(source)}"` : ""}>${esc(biography)}</blockquote>` : "<p>No public biography excerpt is available in this snapshot.</p>"}
        ${source ? `<p><a href="${esc(source)}" rel="noopener">Read the original account and interview at OHP</a></p>` : ""}
      </section>
      <section aria-labelledby="server-places"><h2 id="server-places">Recorded place references</h2>${recordedPlaces(properties)}</section>
      <p><a href="/collection">Return to the collection</a></p>
    </div>
  </main>`;
  const pageShell = sourceOnly ? `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <link rel="stylesheet" href="/css/tokens.css"></head><body></body></html>` : shell;
  const html = rootAssetReferences(pageShell)
    .replace(/<title\b[^>]*>[\s\S]*?<\/title\s*>/gi, "")
    .replace(/<meta\b[^>]*(?:name|property)=["'](?:description|og:[^"']+|twitter:[^"']+)["'][^>]*>/gi, "")
    .replace(/<link\b[^>]*rel=["']canonical["'][^>]*>/gi, "")
    .replace("</head>", `${metadata}\n</head>`)
    .replace(/(<body\b[^>]*>)/i, `$1${article}`);
  return rewriteStaticHtml(html, staticReleaseFromHtml(shell), base);
}

export function renderErrorHtml(status = 404, message = "This page is not in the public archive.") {
  const title = status === 404 ? "Page not found" : status === 400 ? "Unsupported address" : "The archive is temporarily unavailable";
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)} | Crestwood Oral History Project</title>
<link rel="stylesheet" href="/server-profile.css"></head><body>
<main id="server-profile"><div class="server-profile-inner"><p>Crestwood Oral History Project</p>
<h1>${esc(title)}</h1><p>${esc(message)}</p><p><a href="/collection">Browse source accounts</a> ·
<a href="/">Return to Journeys</a> · <a href="https://ohp.crestwood.on.ca/">Visit the original OHP archive</a></p>
</div></main></body></html>`;
}
