// ui.js — overlay panels (landing, explore, history, about) as class-based
// markup over the persistent atlas. Markup here; styling in css; map engine in atlas.js;
// orchestration in app.js. Everyone is presented equally — grouped by the archive's own
// categories (doc 13 §4.2), no "featured" hierarchy (§4.3), each with a brief intro (§4.4).
import { C, GROUP_COLOR, SYSTEM_REDUCED_MOTION, esc } from "./config.js";
import { captionStatus, playerURL } from "./media.js";
import { FLAG_SOURCES, resourcesForYear } from "./historical-context.js";

const RAIL_PAGE = 140;
const icon = (name) => `<svg class="icon icon-${name}" aria-hidden="true" focusable="false">
  <use href="#icon-${name}"></use>
</svg>`;

// ---- LANDING ----------------------------------------------------------------
export function landing(store) {
  const groups = store.groups.length;
  const conflicts = store.conflicts.length;
  return `
  <div class="ov ov-landing">
    <div class="landing-card">
      <h1 class="display">Journeys</h1>
      <p class="landing-subtitle">An atlas of recorded lives</p>
      <p class="lede">Explore the places remembered by Holocaust survivors, veterans,
        and community members in interviews with Crestwood students.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="explore">Explore the collection ${icon("arrow-right")}</button>
        <button class="btn btn-ghost" data-view="patterns">Open the historical atlas</button>
      </div>
      <section class="archive-register" aria-label="Archive totals">
        <div class="register-head">
          <span>Archive register</span>
          <span>Current collection</span>
        </div>
        <div class="register-grid">
          ${counter(store.journeys.length, "people")}
          ${counter(store.placeCount, "places")}
          ${counter(groups, "communities")}
          ${counter(conflicts, "periods")}
        </div>
      </section>
    </div>
  </div>`;
}

function counter(value, label) {
  const initialValue = !SYSTEM_REDUCED_MOTION &&
    document.documentElement.dataset.motion === "gsap" ? 0 : value;
  return `<div class="register-item" aria-label="${value} ${label}">
    <b class="register-number" data-counter="${value}" aria-hidden="true">${initialValue.toLocaleString("en-CA")}</b>
    <span aria-hidden="true">${label}</span>
  </div>`;
}

export function livingMosaic(store) {
  const people = store.journeys
    .map((journey) => ({
      i: journey.initials,
      n: shortName(journey),
      p: clearedPortrait(journey),
      v: journey.portraitFaces > 0,
    }))
    .filter((person) => person.p && person.v);
  const tileCount = Math.min(72, people.length);
  const tiles = Array.from({ length: tileCount }, (_, tileIndex) => {
    const sequence = [];
    for (let index = tileIndex; index < people.length; index += tileCount) {
      sequence.push(people[index]);
    }
    const first = sequence[0];
    return {
      id: tileIndex,
      people: esc(JSON.stringify(sequence)),
      front: mosaicSide(first, "is-front"),
      back: mosaicSide(sequence[1] || first, "is-back"),
    };
  });
  const tileMarkup = (tile, clone = false) => (
    `<span class="mosaic-tile" data-tile-id="${tile.id}"${clone ? ' data-clone="true"' : ""}
      data-people="${tile.people}">
      ${tile.front}
      ${tile.back}
    </span>`
  );
  const belts = Array.from({ length: 6 }, (_, beltIndex) => {
    const row = tiles.slice(beltIndex * 12, beltIndex * 12 + 12);
    return `<div class="mosaic-belt mosaic-belt-${beltIndex + 1}" data-belt="${beltIndex}">
      <div class="mosaic-track">
        <span class="mosaic-set">${row.map((tile) => tileMarkup(tile)).join("")}</span>
        <span class="mosaic-set">${row.map((tile) => tileMarkup(tile, true)).join("")}</span>
      </div>
    </div>`;
  }).join("");
  return `<div class="portrait-mosaic" data-mosaic>
    ${belts}
  </div>`;
}

function mosaicSide(person, className) {
  const portrait = person.p
    ? `<img src="${esc(person.p)}" alt="" loading="lazy" decoding="async">`
    : "";
  return `<span class="mosaic-side ${className}">
    ${portrait}
    <span class="mosaic-initials"${person.p ? " hidden" : ""}>${esc(person.i)}</span>
    <span class="mosaic-name">${esc(person.n)}</span>
  </span>`;
}

function clearedPortrait(journey) {
  const rights = String(journey.portraitRights || "").toLowerCase();
  const original = journey.portrait && /\b(cleared|licensed|public domain|permission granted)\b/.test(rights)
    ? journey.portrait
    : null;
  return original;
}

function profilePicture(journey) {
  return clearedPortrait(journey) || journey.media?.images.find((image) => image.primary)?.url || journey.media?.images[0]?.url || null;
}

// ---- EXPLORE ----------------------------------------------------------------
export function explore(store, state) {
  const groupChips = store.groups.map((g) => {
    const on = state.groupFilter.has(g.name);
    const col = GROUP_COLOR[g.name] || C.accent;
    return `<button class="gchip ${on ? "on" : ""}" data-group="${esc(g.name)}" style="--gc:${col}" aria-pressed="${on}">
      <span class="gcheck">${icon("check")}</span><span>${esc(g.name)}</span>
      <span class="gn">${g.count}</span></button>`;
  }).join("");

  const { html, shown, total } = railInner(store, state);
  return `
  <div class="ov ov-explore ${state.selectedId ? "has-sel" : ""}">
    <aside class="rail scroll" aria-label="Browse the collection">
      <div class="rail-heading"><h2>The collection</h2><span>${store.journeys.length.toLocaleString("en-CA")} people</span></div>
      <div class="rail-search">
        ${icon("search")}
        <input id="search" class="search-input" type="search" placeholder="Search names or places"
          value="${esc(state.query || "")}" autocomplete="off" aria-label="Search people">
      </div>
      <details class="collection-filters"${state.groupFilter.size !== store.groups.length ? " open" : ""}>
        <summary>Communities <span>${state.groupFilter.size === store.groups.length ? "All" : `${state.groupFilter.size} selected`}</span>${icon("chevron")}</summary>
        <div class="gchips">${groupChips}</div>
      </details>
      <div class="rail-count micro-label" data-rail-count role="status">${shown} of ${total} shown</div>
      <div class="rail-list" data-rail-list>${html}</div>
    </aside>
    <div class="panel-host" data-panel>${state.selectedId ? panel(store, state) : ""}</div>
    ${mapTools()}
    ${!state.selectedId ? `<p class="explore-hint">Choose a person to trace their recorded places.</p>` : ""}
  </div>`;
}

export function railInner(store, state) {
  const q = (state.query || "").trim().toLowerCase();
  const match = (j) => state.groupFilter.has(j.group) && (!q || haystack(j).includes(q));
  const matched = store.journeys.filter(match);
  const limit = state.railLimit || RAIL_PAGE;
  const slice = matched.slice(0, limit);

  // Group the slice by archive category, each alphabetical (already sorted by surname).
  const byGroup = new Map();
  for (const j of slice) {
    if (!byGroup.has(j.group)) byGroup.set(j.group, []);
    byGroup.get(j.group).push(j);
  }
  let html = "";
  for (const g of store.groups) {
    const items = byGroup.get(g.name);
    if (!items || !items.length) continue;
    const col = GROUP_COLOR[g.name] || C.accent;
    html += `<div class="rail-group"><div class="rail-ghead" style="--gc:${col}">${esc(g.name)}
      <span class="rail-gn">${items.length}${items.length < (store.groups.find((x) => x.name === g.name).count) ? " shown" : ""}</span></div>`;
    html += items.map((j) => railCard(j, j.id === state.selectedId)).join("");
    html += `</div>`;
  }
  if (!html) html = `<div class="rail-empty"><p>No matching accounts</p>
    <span>Try a surname or place, or reset the search and communities.</span>
    <button class="link" data-act="reset-search">Show the whole collection</button></div>`;
  else if (matched.length > slice.length)
    html += `<button class="rail-more" data-act="more">Show more (${matched.length - slice.length} more)</button>`;
  return { html, shown: slice.length, total: matched.length };
}

function railCard(j, isSel) {
  const col = GROUP_COLOR[j.group] || C.accent;
  return `<button class="rail-card ${isSel ? "sel" : ""}" data-survivor="${esc(j.id)}" aria-pressed="${isSel}">
    ${profileMedal(j, col)}
    <span class="rail-text">
      <span class="rail-name">${esc(j.name)}</span>
      <span class="rail-intro">${profileMeta(j) || esc(j.group)}</span>
    </span></button>`;
}

function panel(store, state) {
  const j = store.byId.get(state.selectedId);
  if (!j) return "";
  const col = GROUP_COLOR[j.group] || C.accent;
  const wp = j.waypoints;
  const usedPassages = new Set();
  const steps = wp.map((w, i) => {
    const passage = sourcePassage(w.quote);
    const showPassage = passage && !usedPassages.has(passage) && !j.bio.includes(passage);
    if (showPassage) usedPassages.add(passage);
    return `<li class="recorded-place">
      <button class="place-focus" data-place-step="${i}" aria-pressed="${state.activePlaceIndex === i}">
        <span class="place-order">${i + 1}</span>
        <span><span class="step-place">${esc(w.canonical)}</span><span class="step-meta">${esc(wpMeta(w))}</span></span>
        ${icon("arrow-right")}
      </button>
      <p class="place-precision">${esc(precisionLabel(w))}${w.locationNote ? `. ${esc(w.locationNote)}` : "."}</p>
      ${w.evidenceScope === "uncertain" && !w.verified ? '<p class="place-review">This mention needs review before it can be treated as a stop in this person\'s journey.</p>' : ""}
      ${showPassage ? `<p class="place-account">${esc(passage)}</p>` : ""}
      ${w.locationSourceUrl ? `<a class="location-source" href="${esc(w.locationSourceUrl)}" target="_blank" rel="noopener">Location reference ${icon("external-link")}</a>` : ""}
    </li>`;
  }).join("");
  const tags = (j.conflicts.concat(j.themes)).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const reviewed = j.reviewStatus === "reviewed";
  return `
    <aside class="panel scroll" aria-labelledby="profile-name">
      <div class="panel-topline"><button class="link" data-act="clear">Back to the collection</button>
        <button class="panel-close" data-act="clear" aria-label="Close profile">${icon("close")}</button></div>
      <div class="profile-heading">
        ${profileMedal(j, col, true)}
        <div>
          <h2 class="serif-lg" id="profile-name" tabindex="-1">${esc(j.name)}</h2>
          <div class="panel-group" style="--gc:${col}">${esc(j.group)}</div>
          <div class="panel-meta">${profileMeta(j)}</div>
        </div>
      </div>
      <div class="profile-actions">
        ${j.videoCount ? `<button class="interview-action" data-act="show-interviews">Watch the interview ${icon("play")}</button>` : ""}
        <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Original interview ${icon("external-link")}</a>
      </div>
      ${recordingMeta(j)}
      <p class="bio">${esc(j.bio || "The original OHP page contains this person's account.")}</p>
      ${profileGallery(j)}
      ${profileInterviews(j)}
      ${j.serviceYear ? `<details class="related-context"><summary>Historical context and maps ${icon("chevron")}</summary>
        <p class="section-note">These sources describe the period. They are separate from ${esc(j.name)}'s own account.</p>
        ${contextResources(j.serviceYear)}</details>` : ""}
      ${j.routeWaypoints.length > 1 ? `<svg class="mini" viewBox="0 0 340 150" data-mini></svg>
      <div class="mini-cap">Connections between city and site references, not exact travel paths.</div>` : ""}
      <section class="profile-places" aria-labelledby="recorded-places-title">
        <h3 id="recorded-places-title">Recorded places</h3>
        <p class="section-note">${wp.length
          ? "The route uses person-linked city and site references. Broad areas and mentions needing review are labelled below. Select a place to inspect its map reference."
          : "This account is in the collection, but its places have not been mapped."}</p>
        ${wp.length ? `<ol class="journey">${steps}</ol>` : ""}
      </section>
      ${contextualPlaces(j)}
      <div class="tags">${tags}</div>
      ${reviewed ? `<div class="ver" style="color:${C.verified}"><span class="ver-dot"></span>Checked against the interview</div>` : ""}
    </aside>`;
}

function sourcePassage(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return /^[\p{Lu}0-9"'(\u201c\u2018]/u.test(text) && /[.!?][\u201d\u2019"')\]]*$/.test(text) ? text : "";
}

function contextualPlaces(journey) {
  if (!journey.contextualPlaces.length) return "";
  const reasons = {
    "ancestor-only": "Family background",
    "ancestor-origin": "Family background",
    "historical-event": "Historical context",
    "military-unit-name": "Military unit name",
    comparison: "Comparison in the source",
  };
  const passages = new Map();
  for (const place of journey.contextualPlaces) {
    const quote = sourcePassage(place.quote);
    const key = `${place.evidenceReason}|${quote || place.canonical}`;
    if (!passages.has(key)) passages.set(key, { places: [], reason: place.evidenceReason, quote });
    passages.get(key).places.push(place.canonical);
  }
  return `<details class="contextual-places">
    <summary>Other places in the source (${journey.contextualPlaces.length}) ${icon("chevron")}</summary>
    <p class="section-note">These mentions concern other people or background context. They are retained here, but are not drawn as this person's route.</p>
    <ul>${[...passages.values()].map((passage) => `<li>
      <strong>${esc(passage.places.join("; "))}</strong>
      <span>${esc(reasons[passage.reason] || "Source context")}</span>
      ${passage.quote ? `<p>${esc(passage.quote)}</p>` : ""}
    </li>`).join("")}</ul>
  </details>`;
}

function precisionLabel(place) {
  return {
    country: "Country-level reference",
    region: "Regional reference",
    city: "City-level reference",
    site: "Site reference",
  }[place.locationPrecision] || "Location precision has not been established";
}

function profileGallery(journey) {
  const images = journey.media.images;
  const references = journey.media.imageReferences;
  if (!images.length && !references.length) return "";
  const figures = images.map((image) => `<figure class="profile-photo">
    <a href="${esc(image.fullUrl || image.sourceUrl || image.url)}" target="_blank" rel="noopener" aria-label="Open photograph from ${esc(journey.name)}'s OHP page">
      <img src="${esc(image.fullUrl || (image.primary ? image.sourceUrl : null) || image.url)}" alt="${esc(image.caption || `Photograph from ${journey.name}'s OHP gallery`)}" loading="lazy" decoding="async">
    </a>
    <figcaption>${esc(image.caption || `This photograph appears on ${journey.name}'s OHP page.`)}
      <span>${esc(image.credit)}</span></figcaption>
  </figure>`);
  return `<section class="profile-gallery" aria-label="Photographs from the original account">
    ${figures[0] || ""}
    ${figures.length > 1 ? `<details class="more-photographs">
      <summary>View ${figures.length - 1} more ${figures.length === 2 ? "photograph" : "photographs"} ${icon("chevron")}</summary>
      <div class="photo-list">${figures.slice(1).join("")}</div>
    </details>` : ""}
    ${references.length ? `<details class="original-gallery">
      <summary>More photographs on OHP (${references.length}) ${icon("chevron")}</summary>
      <p class="section-note">The original gallery includes these additional images. Their individual reuse rights have not been confirmed, so they open at the source.</p>
      <ul>${references.map((image, index) => `<li><a href="${esc(image.sourceUrl || image.url)}" target="_blank" rel="noopener">${esc(
        image.caption && !/^Photograph from |^OHP archive photograph/i.test(image.caption)
          ? image.caption : `Open source photograph ${index + 1}`,
      )} ${icon("external-link")}</a></li>`).join("")}</ul>
    </details>` : ""}
  </section>`;
}

function profileInterviews(journey) {
  if (!journey.videoCount && !journey.media.videos.length) return "";
  const chapters = journey.media.videos.map((video, index) => {
    const playable = playerURL(video);
    const chapterTitle = video.title.replace(new RegExp(`^${index + 1}[.)]\\s*`), "");
    const title = `<span class="video-order">${index + 1}</span><span>${esc(chapterTitle)}
      <small>${esc(captionStatus(video))}</small></span>${icon(playable ? "play" : "external-link")}`;
    return `<li>${playable
      ? `<button class="video-chapter" data-video="${esc(video.id)}">${title}</button>`
      : `<a class="video-chapter" href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">${title}</a>`}</li>`;
  });
  return `<section class="profile-interviews" id="profile-interviews" aria-labelledby="interviews-title">
    <h3 id="interviews-title" tabindex="-1">The interview</h3>
    <p class="section-note">These chapters come from ${esc(journey.name)}'s OHP page. A video loads only when you choose a chapter.</p>
    <div class="interview-player" data-player hidden>
      <div class="player-heading"><strong data-player-title></strong>
        <button data-act="close-video" aria-label="Close video">${icon("close")}</button></div>
      <div class="player-frame" data-player-frame></div>
      <p class="player-note">If Vimeo cannot play this recording here, <a href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">open it on the OHP page</a>.</p>
    </div>
    ${chapters.length ? `<ol class="video-chapters">${chapters.slice(0, 5).join("")}</ol>
      ${chapters.length > 5 ? `<details class="more-videos"><summary>View all ${chapters.length} chapters ${icon("chevron")}</summary>
        <ol class="video-chapters" start="6">${chapters.slice(5).join("")}</ol></details>` : ""}`
      : `<a class="archive-link" href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">Open the interview chapters on OHP ${icon("external-link")}</a>`}
  </section>`;
}

function mapTools() {
  return `<div class="map-tools" role="group" aria-label="Map controls">
    <button data-act="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button>
    <button data-act="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button>
    <button data-act="reset-map" aria-label="Fit map to view" title="Fit map to view">${icon("fit")}</button>
  </div>`;
}

function profileMedal(journey, color, large = false) {
  const portrait = profilePicture(journey);
  return `<span class="medal ${large ? "medal-lg" : ""}" style="--gc:${color}">
    <span class="avatar-initials">${esc(journey.initials)}</span>
    ${portrait ? `<img src="${esc(portrait)}" alt="" loading="lazy" decoding="async">` : ""}
  </span>`;
}

// ---- PATTERNS ---------------------------------------------------------------
export function patterns(store, state) {
  const layer = state.patternsLayer || "journeys";
  const topOrigin = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const toggle = `
    <div class="layer-toggle" role="group" aria-label="Pattern layer">
      <button class="seg ${layer === "journeys" ? "on" : ""}" aria-pressed="${layer === "journeys"}" data-layer="journeys">History and routes</button>
      <button class="seg ${layer === "origins" ? "on" : ""}" aria-pressed="${layer === "origins"}" data-layer="origins">Route origins</button>
    </div>`;

  if (layer === "origins") {
    const list = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
      .map(([c, n]) => `<li><span class="oc-name">${esc(c)}</span><span class="oc-bar"><span style="width:${Math.round(n / topOrigin[1] * 100)}%"></span></span><span class="oc-n">${n}</span></li>`).join("");
    return `
    <div class="ov ov-patterns is-origins">
      <div class="patterns-intro">
        <h2 class="serif-xl">Where the mapped routes begin</h2>
        <p class="lede sm">${topOrigin
          ? `<span class="accent">${esc(topOrigin[0])}</span> has the largest count, with <b>${topOrigin[1]}</b> mapped starting places.`
          : "No mapped starting places are available."}</p>
        ${toggle}
        <ul class="origin-list">${list}</ul>
        <p class="cross-sub">This layer counts the first place in each mapped route, not confirmed birthplaces. Historical names are grouped under present-day countries.</p>
      </div>
      ${mapTools()}
    </div>`;
  }

  return `
  <div class="ov ov-patterns">
    <div class="patterns-map-head">
      <h2>Territory and testimony</h2>
      <p class="history-scope">Explore dated borders and recorded accounts, ${store.time.min} to ${store.time.max}.</p>
      ${toggle}
      <form class="history-search" data-history-search>
        <label class="sr-only" for="history-location">Find a country or an OHP place</label>
        <input id="history-location" type="search" list="history-locations" placeholder="Find a country or recorded place" autocomplete="off" data-country-search>
        <button type="submit" aria-label="Find location">${icon("search")}</button>
        <datalist id="history-locations"></datalist>
      </form>
      <p class="history-search-status" data-search-status role="status"></p>
      <div class="history-toolbar">
        <details class="history-settings">
          <summary>${icon("layers")} Map layers ${icon("chevron")}</summary>
          <div class="history-settings-body">
            <label><input type="checkbox" data-history-setting="flags"${state.historyFlags ? " checked" : ""}> Historical flags</label>
            <label><input type="checkbox" data-history-setting="labels"${state.historyLabels ? " checked" : ""}> Territory names</label>
            <label><input type="checkbox" data-history-setting="routes"${state.historyRoutes ? " checked" : ""}> Shared interview routes</label>
            <p class="section-note" data-route-availability>${store.corridorsForYear(state.scrubYear).length
              ? "Only person-linked city/site pairs dated to this year are connected."
              : "No shared city/site routes have sufficient date evidence for this year."}</p>
            <label><input type="checkbox" data-history-setting="testimony"${state.historyTestimony ? " checked" : ""}> Recorded places</label>
            <label><input type="checkbox" data-history-setting="compare"${state.historyCompare ? " checked" : ""}> Compare with today's borders</label>
            <label class="history-range-label">Historical layer opacity
              <input type="range" min="0.2" max="1" step="0.05" value="${state.historyOpacity}" data-history-opacity aria-label="Historical layer opacity"></label>
            <label class="history-range-label" data-compare-control${state.historyCompare ? "" : " hidden"}>Move the comparison divider
              <input type="range" min="0" max="100" step="1" value="${state.historySplit}" data-history-split aria-label="Historical comparison divider"></label>
            <button class="compact-layer-switch" data-layer="origins">Show mapped route origins</button>
          </div>
        </details>
        <button class="history-share" data-act="share-map" aria-label="Copy map link" title="Copy map link">${icon("share")}</button>
        ${mapTools()}
      </div>
      <p class="history-share-status" data-share-status role="status"></p>
      <input class="share-address" data-share-address aria-label="Map link" readonly hidden>
    </div>
    <aside class="history-dossier" aria-label="Historical context and recorded places">
      <details class="history-context-disclosure" data-history-context${(state.historyContextOpen ?? window.innerWidth > 820) ? " open" : ""}>
        <summary>Year context and sources <span data-year>${state.scrubYear}</span>${icon("chevron")}</summary>
        <div class="history-context-body" data-pattern-events tabindex="0">${patternsEvents(store, state)}</div>
      </details>
    </aside>
    <div class="scrubber">
      <div class="scrub-head">
        <button class="history-play" data-act="play-history" aria-label="${state.historyPlaying ? "Pause history" : "Play history"}" aria-pressed="${state.historyPlaying}">${icon(state.historyPlaying ? "pause" : "play")}</button>
        <span class="timeline-label">Historical timeline</span>
        <div class="year-navigation">
          <button data-act="prev-year" aria-label="Previous year"${state.scrubYear <= store.time.min ? " disabled" : ""}>${icon("arrow-right")}</button>
          <form data-year-form><label class="sr-only" for="history-year">Year</label>
            <input id="history-year" class="scrub-year" type="number" min="${store.time.min}" max="${store.time.max}" step="1" required value="${state.scrubYear}" data-year data-year-entry aria-label="Year">
          </form>
          <button data-act="next-year" aria-label="Next year"${state.scrubYear >= store.time.max ? " disabled" : ""}>${icon("arrow-right")}</button>
        </div>
      </div>
      <input class="range" type="range" min="${store.time.min}" max="${store.time.max}" step="1" value="${state.scrubYear}" data-scrub aria-label="Year, ${store.time.min} to ${store.time.max}">
      ${boundaryDensity(store, state.scrubYear)}
      <div class="scrub-ticks"><span>${store.time.min}</span><span>1945</span><span>1989</span><span>${store.time.max}</span></div>
      <div class="compare-caption" data-compare-caption${state.historyCompare ? "" : " hidden"}>
        <span>Left: <b data-year>${state.scrubYear}</b> borders</span><span>Right: today's borders</span>
      </div>
    </div>
  </div>`;
}

export function patternsEvents(store, state) {
  const events = store.eventsByYear.get(state.scrubYear) || [];
  const activeEvent = events.find((event) => event.key === state.patternEventKey) || null;
  return `
    ${state.historyInfo ? countryInspector(state.historyInfo, state.scrubYear) : warBrief(store, state.scrubYear, state.historyRoutes)}
    ${state.historyTestimony ? testimonyMoment(activeEvent, events) : ""}
    <details class="history-sources">
      <summary>Original maps and historical context ${icon("chevron")}</summary>
      ${contextResources(state.scrubYear)}
      <p class="history-method">The atlas samples the middle of each year. Its polygons are generalized source records, not exact borders or daily front lines.
        Dashed outlines mark overlapping alternatives. Flags appear only where the dated design has been verified.</p>
      <a class="catalogue-link" href="data/historical_boundary_quality.json" target="_blank" rel="noopener">Open the geometry audit ${icon("external-link")}</a>
    </details>`;
}

function countryInspector(country, year) {
  const flag = country.flag;
  return `<section class="country-inspector">
    <button class="country-back" data-act="clear-country">${icon("arrow-right")} Back to ${year}</button>
    <div class="country-heading">${flag ? `<img class="country-flag" src="${esc(flag.src)}" alt="${esc(flag.label)}" width="66" height="44">` : ""}
      <div><h3 tabindex="-1">${esc(country.name)}</h3><p>${country.alternativeRecords
        ? `Source outlines overlap in ${year}` : `Mapped in ${year}`}</p></div></div>
    ${flag ? `<details class="flag-details"><summary>Flag dates and source ${icon("chevron")}</summary>
      <p class="flag-note">${esc(readableFlagText(flag.note || ""))}
      ${flag.start ? `<span class="flag-dates">The recorded use dates are ${esc(flag.start)}${flag.end ? ` to ${esc(flag.end)}` : " onward"}.</span>` : ""}
      <a href="${esc(flag.sourceUrl)}" target="_blank" rel="noopener">Flag source and dates ${icon("external-link")}</a>
      <span class="flag-credit">${esc(readableFlagText([flag.credit, flag.license].filter(Boolean).join(", ")))}</span></p></details>
      <p class="flag-summary">${esc(readableFlagText(flag.label))}</p>`
      : '<p class="flag-note">A flag design has not been verified for this administration at this date.</p>'}
    ${country.alternativeRecords ? `<p class="source-caution">${country.alternativeRecords} dated source outlines overlap for this name.
      Dashed borders mark these unverified alternatives.</p>` : ""}
    ${country.inferredGrouping ? '<p class="country-source">This administration grouping is inferred from source names. It is not independent verification of effective control.</p>' : ""}
    <details class="country-areas"><summary>View ${country.count} mapped ${country.count === 1 ? "area" : "areas"} ${icon("chevron")}</summary>
      <ul>${country.territories.map((territory) => `<li><strong>${esc(territory.name)}</strong>
        <span>${esc(territory.dates)}${territory.kind ? `, ${esc(territory.kind.replaceAll("_", " "))}` : ""}</span></li>`).join("")}</ul>
    </details>
    <a class="archive-link" href="${esc(country.externalUrl)}" target="_blank" rel="noopener">Open this area in OldMapsOnline ${icon("external-link")}</a>
    <p class="country-source">Territory records: <a href="https://www.openhistoricalmap.org/" target="_blank" rel="noopener">OpenHistoricalMap (CC0)</a>.</p>
  </section>`;
}

function readableFlagText(text) {
  return String(text).replace(/\s+\u2014\s+/g, ", ").replace(/\u2013/g, " to ");
}

function contextResources(year) {
  const resources = resourcesForYear(year);
  return `<ul class="context-resources">${resources.map((resource) => `<li>
    <a href="${esc(resource.url)}" target="_blank" rel="noopener">${icon(resource.kind === "video" ? "play" : "external-link")}<span>${esc(resource.title)}</span></a>
    <span class="resource-credit">${esc(resource.publisher)}${resource.publishedYear ? `, ${esc(resource.publishedYear)}` : ""}</span>
    ${resource.note ? `<p>${esc(resource.note)}</p>` : ""}</li>`).join("")}</ul>
    <a class="catalogue-link" href="https://www.oldmapsonline.org/en" target="_blank" rel="noopener">Search the scanned-map catalogue on OldMapsOnline ${icon("external-link")}</a>`;
}

// ---- ABOUT ------------------------------------------------------------------
export function about(store) {
  const collection = store.groups.map((g) => `<div><dt>${esc(g.name)}</dt><dd>${g.count.toLocaleString("en-CA")}</dd></div>`).join("");
  return `
  <div class="ov ov-about scroll">
    <div class="about-wrap">
      <header class="about-header">
        <h1 class="display sm">About the map</h1>
        <p class="lede">Crestwood students have recorded interviews with Holocaust survivors,
        veterans, and community members for years. This map organizes the places named in
        those interviews so visitors can follow one route or compare many accounts.</p>
      </header>
      <div class="about-body">
        <aside class="collection-ledger">
          <h2>The collection</h2>
          <p>${store.journeys.length.toLocaleString("en-CA")} people, grouped as they are in the OHP archive.</p>
          <dl>${collection}</dl>
          <a class="archive-link" href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">Visit the original archive ${icon("external-link")}</a>
        </aside>
        <div class="about-grid">
        <section><h2>Reading a recorded life</h2><p>Explore brings each person's account, photographs,
          interview chapters, and recorded places together. The historical atlas puts dated accounts
          alongside changing territories from 1914 to 2026.</p></section>
        <section><h2>From testimony to map</h2><p>Each route uses places named on a public OHP
          page. Historical names are matched to current locations, so &quot;Lemberg&quot;
          resolves to Lviv. Dates determine the order when the source provides them.</p>
          <p>Routes connect recorded places; they do not reconstruct the exact roads a person
          travelled. Approximate dates remain labelled as approximate.</p></section>
        <section><h2>Read alongside the original</h2><p>Profiles are built from public OHP
          summaries. Automated place matching has not been checked for every profile.
          Each account links to its original interview so you can read and listen in context.</p></section>
        <section><h2>Location and boundary accuracy</h2>
          <p>City and site markers are reference points, not exact positions within a building or town.
          Country and regional references cover broader areas. Uncertain dates and contextual mentions
          should not be read as verified stops in a person's journey.</p>
          <p>The historical polygons come from a generalized OpenHistoricalMap world tile. They sample
          the middle of each year and can contain overlapping source records. Valid polygon geometry
          does not establish that every border or administration is historically correct.</p>
          <p><a href="data/historical_boundary_quality.json" target="_blank" rel="noopener">Read the geometry and overlap audit</a>.</p>
        </section>
        <section class="about-sources"><h2>Sources and credits</h2>
          <dl>
            <div><dt>Interviews and photographs</dt><dd><a href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">Crestwood Oral History Project</a></dd></div>
            <div><dt>Historical territories</dt><dd>OpenHistoricalMap (CC0)</dd></div>
            <div><dt>War participants</dt><dd>Correlates of War, Inter-State War Data v4.0</dd></div>
            <div><dt>Basemap</dt><dd>Natural Earth via world-atlas</dd></div>
            <div><dt>Historical flags</dt><dd>Each flag uses a documented design, with its dates, source, and reuse terms available in the territory record.</dd></div>
            <div><dt>Historical map reference</dt><dd><a href="https://www.oldmapsonline.org/en" target="_blank" rel="noopener">OldMapsOnline</a> is an external reference and scanned-map catalogue. Its catalogue is not reproduced here.</dd></div>
            <div><dt>Website code</dt><dd><a href="https://github.com/AlexDongzeyu/OHP-Map" target="_blank" rel="noopener">AlexDongzeyu/OHP-Map</a></dd></div>
          </dl>
          <details class="flag-source-list">
            <summary>Flag image credits and licences (${FLAG_SOURCES.length}) ${icon("chevron")}</summary>
            <ul>${FLAG_SOURCES.map((source) => `<li>
              <a href="${esc(source.sourceUrl)}" target="_blank" rel="noopener">${esc(readableFlagText(source.title))}</a>
              <p>${esc(readableFlagText(source.credit))}</p>
              <a href="${esc(source.licenseUrl)}" target="_blank" rel="noopener">${esc(source.license)}</a>
              <p>${esc(readableFlagText(source.note))}</p>
            </li>`).join("")}</ul>
          </details>
        </section>
        </div>
      </div>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="explore">Explore the collection ${icon("arrow-right")}</button>
        <button class="btn btn-ghost" data-act="home">Back to the start</button>
      </div>
    </div>
  </div>`;
}

// ---- helpers ----------------------------------------------------------------
function shortName(j) {
  const p = j.name.split(" ");
  return p.length > 1 ? `${p[0]} ${j.surname[0]}.` : j.name;
}
function haystack(j) {
  return (j.name + " " + j.hometown + " " + j.group + " " + j.conflicts.join(" ") + " " +
    j.themes.join(" ") + " " + j.waypoints.map((w) => w.canonical + " " + w.asWritten).join(" ")).toLowerCase();
}
function wpMeta(w) {
  const yr = w.year
    ? (w.endYear && w.endYear !== w.year ? `${w.year} to ${w.endYear}` : (w.approx ? `around ${w.year}` : `${w.year}`))
    : (w.dateAsWritten ? `date uncertain; source says "${w.dateAsWritten}"` : "date uncertain");
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? `. Listed as "${w.asWritten}"` : "";
  return `${w.role}, ${yr}${written}`;
}
function profileMeta(journey) {
  const places = `${journey.waypoints.length} recorded ${journey.waypoints.length === 1 ? "place" : "places"}`;
  return journey.born ? `Born ${journey.born}. ${places}.` : `${places}.`;
}
function recordingMeta(journey) {
  if (!journey.videoCount) return "";
  let captionText;
  if (journey.transcriptStatus === "pending") {
    captionText = "Caption availability is being checked.";
  } else if (journey.transcriptStatus === "unavailable") {
    captionText = "Vimeo did not expose caption information for these chapters.";
  } else if (journey.captionedVideoCount) {
    captionText = `Public captions are available for ${journey.captionedVideoCount} ${journey.captionedVideoCount === 1 ? "chapter" : "chapters"}.`;
  } else {
    captionText = "Vimeo does not provide public captions for these chapters.";
  }
  return `<p class="recording-meta">
    <span>This interview has ${journey.videoCount} ${journey.videoCount === 1 ? "chapter" : "chapters"}.</span>
    <span>${captionText}</span>
  </p>`;
}
function warBrief(store, year, showRoutes = true) {
  const context = store.warAt(year);
  if (!context) return "";
  const boundary = store.historicalIndex.years.find((entry) => entry.year === year);
  const eraMap = year <= 1918 ? 1914 : (
    year <= 1945 ? 1944 : (year <= 1988 ? 1960 : (year <= 2000 ? 1991 : 2026))
  );
  const corridors = showRoutes ? store.corridorsForYear(year) : [];
  const legend = context.coalition_label ? `
    <div class="war-legend" aria-label="Historical alignment legend">
      <span><i class="coalition"></i>${esc(context.coalition_label)}</span>
      <span><i class="opposition"></i>${esc(context.opposition_label)}</span>
      ${context.occupied.length ? '<span><i class="occupied"></i>Occupied / contested</span>' : ""}
      ${corridors.length ? `<span><i class="route"></i>${corridors.length} routes shared by veterans</span>` : ""}
    </div>` : `
    <div class="war-legend" aria-label="Territorial map legend">
      <span><i class="territory"></i>Dated territory</span>
      <span><i class="route"></i>Recorded route</span>
    </div>`;
  return `<section class="war-brief" data-war-context>
    <img class="war-brief-map" src="assets/history/atlas-${eraMap}.svg" alt="" aria-hidden="true">
    <div class="war-brief-content">
      <strong>${esc(context.phase)}</strong>
      <div class="war-brief-top"><span>${esc(context.conflict)}</span><b data-year>${year}</b></div>
      <p>${esc(context.summary)}</p>
      ${legend}
      <small>
        <span>${boundary ? `${boundary.active} territories, ${boundary.changes} changes` : ""}</span>
        <span>OpenHistoricalMap (CC0)</span>
      </small>
    </div>
  </section>`;
}
function testimonyMoment(activeEvent, events) {
  if (!events.length) {
    return `<div class="testimony-moment is-empty">
      <span class="micro-label">Testimony layer</span>
      <p>No person-linked place has a sufficiently precise date for this year.</p>
    </div>`;
  }
  if (!activeEvent) {
    return `<div class="testimony-moment">
      <span class="micro-label">${events.length} recorded ${events.length === 1 ? "place" : "places"}</span>
      <p>Select a ring on the map to see the people recorded at that place.</p>
    </div>`;
  }
  const portraits = activeEvent.people.filter((person) => person.portrait).slice(0, 5)
    .map((person) => `<img src="${esc(person.portrait)}" alt="" loading="lazy" decoding="async">`).join("");
  const personLink = (person) => `<button class="event-person" data-survivor="${esc(person.id)}">${esc(person.name)}</button>`;
  const names = activeEvent.people.slice(0, 4).map(personLink).join("");
  return `<div class="testimony-moment is-selected">
    <div class="moment-head">
      <span class="event-role">${esc(activeEvent.role)}</span>
      <span class="moment-nav">
        <button data-act="prev-event" aria-label="Previous testimony place">${icon("arrow-right")}</button>
        <b>${events.indexOf(activeEvent) + 1} / ${events.length}</b>
        <button data-act="next-event" aria-label="Next testimony place">${icon("arrow-right")}</button>
      </span>
    </div>
    <strong>${esc(activeEvent.place)}</strong>
    <span class="event-people">
      <span class="event-portraits">${portraits}</span>
      <span class="event-names">${names}</span>
    </span>
    ${activeEvent.people.length > 4 ? `<details class="more-event-people"><summary>Show all ${activeEvent.people.length} people ${icon("chevron")}</summary>
      <div>${activeEvent.people.slice(4).map(personLink).join("")}</div></details>` : ""}
    <small>${activeEvent.count} ${activeEvent.count === 1 ? "interview" : "interviews"}${activeEvent.approximate ? ", some dates are approximate" : ""}</small>
  </div>`;
}
function boundaryDensity(store, selectedYear) {
  const years = store.historicalIndex?.years || [];
  const maximum = Math.max(1, ...years.map((entry) => entry.changes));
  return `<div class="boundary-density" aria-label="Frequency of mapped territorial changes by year">
    ${years.map((entry) => {
      const height = Math.max(12, Math.round(entry.changes / maximum * 100));
      return `<i data-boundary-year="${entry.year}" class="${entry.year === selectedYear ? "on" : ""}"
        style="--change-height:${height}%" title="${entry.year}: ${entry.changes} mapped boundary changes"></i>`;
    }).join("")}
  </div>`;
}
