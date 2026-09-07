// ui.js — overlay panels (landing, explore, history, about) as class-based
// markup over the persistent atlas. Markup here; styling in css; map engine in atlas.js;
// orchestration in app.js. Everyone is presented equally — grouped by the archive's own
// categories (doc 13 §4.2), no "featured" hierarchy (§4.3), each with a brief intro (§4.4).
import { C, GROUP_COLOR, SYSTEM_REDUCED_MOTION, siteResource, esc, normalizeSearch } from "./config.js";
import { captionStatus, playerURL } from "./media.js";
import { FLAG_SOURCES, FLAG_CATALOGUE_META, resourcesForYear } from "./historical-context.js";
import { collectionResults, collectionPlaces, evidenceCounts, searchSuggestions, searchMatchLabels, relatedAccounts } from "./data.js";
import { accountLink, accountCitation } from "./research-tools.js";

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
      <p class="landing-source-note">${store.journeys.filter((journey) => journey.reviewStatus === "reviewed").length
        ? "Each account labels reviewed map references and those still awaiting review."
        : "Map references come from public summaries and still need human review."}</p>
    </div>
  </div>`;
}

function counter(value, label) {
  const initialValue = !SYSTEM_REDUCED_MOTION &&
    document.documentElement.dataset.motion === "gsap" ? 0 : value;
  return `<div class="register-item" role="group" aria-label="${value} ${label}">
    <b class="register-number" data-counter="${value}" aria-hidden="true">${initialValue.toLocaleString("en-CA")}</b>
    <span aria-hidden="true">${label}</span>
  </div>`;
}

export function livingMosaic(store) {
  const people = store.journeys
    .map((journey) => ({
      i: journey.initials,
      n: shortName(journey),
      p: siteResource(clearedPortrait(journey)),
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
    ? `<img src="${esc(siteResource(person.p))}" alt="" loading="lazy" decoding="async">`
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
    return `<label class="gchip">
      <input type="checkbox" data-group="${esc(g.name)}"${on ? " checked" : ""}>
      <span>${esc(g.name)}</span><span class="gn">${g.count}</span></label>`;
  }).join("");

  const { html, shown, total } = railInner(store, state);
  const filtered = state.query || state.originCountry || state.placeFilter || state.captionedOnly || state.groupFilter.size !== store.groups.length;
  return `
  <div class="ov ov-explore ${state.selectedId ? "has-sel" : ""}">
    <h1 class="sr-only">${state.selectedId ? `${esc(store.byId.get(state.selectedId)?.name)}'s account` : "Explore the collection"}</h1>
    <aside class="rail scroll" aria-label="Browse the collection">
      <div class="rail-heading"><h2 data-collection-title>${collectionTitle(state)}</h2>
        <button class="saved-view" data-act="toggle-saved-view">${savedViewLabel(store, state)}</button></div>
      <div class="saved-privacy" data-saved-privacy${state.savedOnly ? "" : " hidden"}>
        <p>Saved only in this browser.</p>
        <button class="link" data-act="manage-saved-list" aria-haspopup="dialog">Back up or restore</button>
      </div>
      <div class="reading-list-tools" data-reading-list-tools${state.savedOnly || state.sharedIds ? "" : " hidden"}>${readingListTools(store, state)}</div>
      <p class="saved-feedback" data-saved-feedback aria-live="${state.selectedId ? "off" : "polite"}"${state.savedError ? "" : " hidden"}>${esc(state.savedError || "")}</p>
      <div class="rail-search">
        ${icon("search")}
        <input id="search" class="search-input" type="search" placeholder="Name, place or period"
          value="${esc(state.query || "")}" autocomplete="off" enterkeyhint="search"
          title="Combine words to narrow results. Use quotes for a phrase."
          aria-label="Search the collection" aria-describedby="collection-search-help">
        <p class="sr-only" id="collection-search-help">Every word must match. Use double quotes for a phrase. Press Enter or Down arrow to browse the results.</p>
      </div>
      <details class="collection-filters">
        <summary>Filters <span data-group-count>${filterSummary(store, state)}</span>${icon("chevron")}</summary>
        <div class="filter-actions">
          <button class="link" data-act="all-groups">Select all</button>
          <button class="link" data-act="no-groups">Clear selection</button>
          <button class="link filter-done" data-act="close-filters">Done</button>
        </div>
        <fieldset class="gchips"><legend class="sr-only">Include communities</legend>${groupChips}</fieldset>
        <fieldset class="resource-filters"><legend class="sr-only">Interview material</legend>
          <label class="resource-choice"><input type="checkbox" data-caption-filter${state.captionedOnly ? " checked" : ""}>
            <span>Captioned chapters</span><span data-caption-count>${captionedResultCount(store, state)}</span></label>
          <p>Uses recorded caption listings. Playback and caption access still depend on the video provider.</p>
        </fieldset>
      </details>
      <div class="origin-filter" data-origin-filter${state.originCountry ? "" : " hidden"}>
        <span>Routes starting in <strong data-origin-name>${esc(state.originCountry || "")}</strong></span>
        <button data-act="clear-origin" aria-label="Clear origin filter">${icon("close")}</button>
        <button class="link" data-act="origin-overview">Back to route origins</button>
      </div>
      <div class="rail-summary">
        <div class="rail-count micro-label" data-rail-count role="status">${shown} of ${total} shown</div>
        <button class="link filter-reset" data-act="reset-search"${filtered ? "" : " hidden"}>Reset filters</button>
        <button class="link collection-map-toggle" data-act="show-explore-map">Map ${icon("arrow-right")}</button>
      </div>
      <div class="place-filter" data-place-filter${state.placeFilter ? "" : " hidden"}>
        <span>Accounts naming <strong data-place-filter-name>${esc(state.placeFilter || "")}</strong></span>
        <button data-act="clear-place-filter" aria-label="Clear place filter">${icon("close")}</button>
      </div>
      <div class="collection-shortcuts"><button class="link" data-act="focus-map">Skip to map ${icon("arrow-right")}</button>
        <button class="link" data-act="browse-places" aria-haspopup="dialog">Browse places</button>
        ${state.selectedId ? '<button class="link" data-act="focus-reader">Skip to account</button>' : ""}</div>
      <p class="sr-only" id="collection-keyboard-help">Use Up and Down arrows to browse accounts. Tab moves to Save, then leaves the list.</p>
      <div class="rail-list" data-rail-list role="list" aria-describedby="collection-keyboard-help">${html}</div>
    </aside>
    <div class="panel-host" data-panel>${state.selectedId ? panel(store, state) : ""}</div>
    ${mapTools(Boolean(state.selectedId))}
    <div class="explore-map-status">
      <p class="explore-map-caption" data-explore-map-caption aria-live="polite">${exploreMapCaption(store, state)}</p>
      ${boundaryNotice()}
      ${mapLegend("explore")}
    </div>
    ${!state.selectedId ? `<p class="explore-hint" data-explore-hint>${exploreHint(store, state, total)}</p>` : ""}
    <button class="reader-return" data-act="show-reader">${state.selectedId
      ? `Read ${esc(store.byId.get(state.selectedId).name)}'s account` : "Browse the collection"} ${icon("arrow-right")}</button>
  </div>`;
}

export function railInner(store, state) {
  const matched = collectionResults(store, state);
  const limit = state.railLimit || RAIL_PAGE;
  const slice = matched.slice(0, limit);

  // The full result order is shared with the reader's previous/next controls.
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
    html += items.map((j) => railCard(j, state)).join("");
    html += `</div>`;
  }
  if (!html) {
    const emptySaved = state.savedOnly && !savedCount(store, state);
    const unavailableSaved = emptySaved && state.savedIds.size > 0 && !state.savedError;
    const emptyShared = state.sharedIds && !store.journeys.some(journey => state.sharedIds.has(journey.id));
    const suggestions = state.query ? searchSuggestions(store, state) : [];
    html = `<div class="rail-empty" tabindex="-1" role="region" aria-label="Collection results"><p>${emptyShared ? "These accounts are not available yet" : emptySaved
      ? (state.savedError ? "Saved accounts are unavailable" : unavailableSaved
        ? "Saved accounts are missing from this version of the archive" : "Keep an account for later")
      : state.groupFilter.size ? (state.query ? "No account matches every search term" : "No matching accounts") : "No communities selected"}</p>
      <span>${emptyShared ? "The link still includes every account in the list. Reload the collection to check for updates, or browse the available accounts."
        : emptySaved ? (state.savedError
        ? "Your existing list has not been changed. You can browse the collection and copy account links instead."
        : unavailableSaved ? "Your list still keeps these entries. Check again for archive updates, or use Back up or restore to keep a copy."
        : "Use the bookmark beside a name or Save account in the reader. You can return to your list here.")
        : !state.groupFilter.size ? "Select at least one community to search this collection."
        : state.query ? "Try fewer words or a different spelling. Double quotes keep a phrase together. Search covers names, places, periods and topics, not full biographies or transcripts."
        : "Try another name or place, or reset the collection filters."}</span>
      ${suggestions.length ? `<div class="search-suggestions"><span>Try a close spelling</span>${suggestions.map((suggestion) =>
        `<button class="link" data-search-suggestion="${esc(suggestion)}">Search ${esc(suggestion)}</button>`).join("")}</div>` : ""}
      <button class="link" data-act="${emptyShared ? "leave-shared-list" : "reset-search"}">${emptyShared ? "Show the whole collection"
        : state.sharedIds ? "Show all accounts in this list" : state.savedOnly && !emptySaved ? "Show all saved accounts" : "Show the whole collection"}</button></div>`;
  }
  else if (matched.length > slice.length)
    html += `<button class="rail-more" data-act="more">Show more (${matched.length - slice.length} more)</button>`;
  if (state.savedOnly) html += `<div class="saved-list-footer"><button class="link" data-act="reset-saved-list">Clear saved list</button></div>`;
  return { html, shown: slice.length, total: matched.length };
}

function savedCount(store, state) {
  return store.journeys.filter((journey) => state.savedIds.has(journey.id)).length;
}

export function exploreHint(store, state, total) {
  if (total) return "Choose an account or a place marker to explore its source references.";
  if (state.savedOnly && !savedCount(store, state)) {
    if (state.savedError) return "Your saved list could not be read. Browse available accounts or allow browser storage to try again.";
    if (state.savedIds.size) return "These saved accounts are missing from this version of the archive. Your list still keeps their entries. Check again for updates.";
    return "Your saved list is empty. Browse the collection and save an account to map its references.";
  }
  return "No accounts match these filters. Reset the filters or try a different spelling.";
}

export function savedViewLabel(store, state) {
  return state.savedOnly || state.sharedIds ? `${icon("arrow-right")} All accounts`
    : `${icon("bookmark")} Saved <span>${state.savedIds.size}</span>`;
}

export function collectionTitle(state) {
  return state.sharedIds ? "Shared reading list" : state.savedOnly ? "Saved accounts" : "The collection";
}

export function filterSummary(store, state) {
  const communities = state.groupFilter.size === store.groups.length ? "All" : `${state.groupFilter.size} selected`;
  return `${communities}${state.captionedOnly ? " + captions" : ""}`;
}

export function captionedResultCount(store, state) {
  return collectionResults(store, { ...state, captionedOnly: true }).length;
}

export function readingListTools(store, state) {
  if (!state.savedOnly && !state.sharedIds) return "";
  const results = collectionResults(store, state);
  const listIds = state.sharedIds || (state.savedOnly && !state.savedError ? state.savedIds : null);
  const missing = listIds ? [...listIds].filter(id => !store.byId.has(id)).length : 0;
  const allSaved = results.length && results.every(journey => state.savedIds.has(journey.id));
  return `${state.sharedIds ? `<p class="shared-list-note">Someone shared this list of public accounts. Opening it does not change your saved accounts.</p>` : ""}
    ${missing ? `<p class="shared-list-warning" role="status">${missing} ${missing === 1 ? "account is" : "accounts are"} not available in this version of the archive.
      ${state.sharedIds ? "" : `${missing === 1 ? "It remains" : "They remain"} in your saved list and backups.`}
      <button class="link" data-act="reload-collection">Check again</button></p>` : ""}
    <div class="reading-list-actions">
      ${state.sharedIds ? `<button class="link" data-act="save-shared-list"${!results.length || allSaved ? " disabled" : ""}>
        ${allSaved ? "Saved here" : `Save ${results.length} ${results.length === 1 ? "account" : "accounts"}`}</button>` : ""}
      <button class="link" data-act="share-reading-list" aria-haspopup="dialog"${results.length ? "" : " disabled"}>Share list</button>
      <button class="link" data-act="download-list-sources"${results.length ? "" : " disabled"}>Download citations</button>
    </div>`;
}

function researchDialog(id, title, body) {
  return `<dialog class="research-dialog" id="${id}" aria-labelledby="${id}-title">
    <header class="research-dialog-heading"><h2 id="${id}-title">${esc(title)}</h2>
      <button data-act="close-research-dialog" aria-label="Close ${esc(title.toLowerCase())}">${icon("close")}</button></header>
    <div class="research-dialog-body">${body}</div>
  </dialog>`;
}

export function savedListDialog(state) {
  return researchDialog("saved-list-dialog", "Your saved list", `
    <p class="research-dialog-intro">Download your saved list to keep a copy or move it to another browser. The backup contains your selection, not biographies or videos. The site does not upload it.</p>
    <section class="saved-backup-section" aria-labelledby="saved-backup-heading">
      <h3 id="saved-backup-heading">Keep a copy</h3>
      <p data-saved-backup-count>${state.savedIds.size} saved ${state.savedIds.size === 1 ? "account" : "accounts"}. The backup includes all saved accounts, regardless of filters.</p>
      <button class="btn btn-ghost" data-download-saved-backup${state.savedIds.size && !state.savedError ? " autofocus" : " disabled"}>Download backup</button>
      <p class="reference-status" data-saved-backup-status role="status">${esc(state.savedError)}</p>
    </section>
    <section class="saved-backup-section" aria-labelledby="saved-restore-heading">
      <h3 id="saved-restore-heading">Restore from a backup</h3>
      <p id="saved-backup-help">Preview an OHP backup before adding its accounts. Restoring it keeps everything already in your saved list.</p>
      <label for="saved-backup-file">Choose a saved-list backup</label>
      <input id="saved-backup-file" type="file" accept=".json,application/json" aria-describedby="saved-backup-help"${!state.savedIds.size || state.savedError ? " autofocus" : ""}>
      <p class="reference-status" data-saved-import-status role="status"></p>
      <div data-saved-import-preview></div>
      <div class="research-dialog-actions" data-saved-import-actions hidden>
        <button class="btn btn-primary" data-restore-saved-backup disabled>Add accounts</button>
        <button class="link" data-act="close-research-dialog">Cancel</button>
      </div>
    </section>`);
}

export function savedListFilePreview(ids, store) {
  const available = [...ids].map(id => store.byId.get(id)).filter(Boolean);
  const missing = ids.size - available.length;
  return `${missing ? `<p class="shared-list-warning">${missing} ${missing === 1 ? "account is" : "accounts are"} not available in this version of the archive.
      Your saved list and future backups will keep ${missing === 1 ? "this entry" : "these entries"}, even though you cannot open ${missing === 1 ? "it" : "them"} here yet.</p>` : ""}
    <ul class="reading-list-preview">${available.slice(0, 3).map(journey => `<li>${esc(journey.name)}</li>`).join("")}
      ${available.length > 3 ? `<li class="reading-list-more">And ${available.length - 3} more available accounts</li>` : ""}</ul>`;
}

export function biographyContent(journey) {
  if (journey.biographyState === "ready") {
    const paragraphs = journey.fullBiography.trim().split(/\n\s*\n/);
    const words = journey.fullBiography.trim().split(/\s+/).length;
    return `<p class="biography-source-label">Public OHP biography · ${words} words</p>
      <p class="research-dialog-note">This is a saved copy of the original OHP biography, not a verbatim interview transcript. Each map reference has its own accuracy and review notes.</p>
      <div class="full-biography-text" tabindex="0" aria-label="Full source biography">${paragraphs.map(paragraph => `<p>${esc(paragraph)}</p>`).join("")}</div>`;
  }
  if (journey.biographyState === "error") {
    return `<div class="biography-recovery" role="status"><h3>The full biography could not load</h3>
      <p>${esc(journey.biographyError || "The source text is not available in this version of the archive.")}</p>
      <button class="link" data-act="retry-biography">Try again</button></div>`;
  }
  return `<div class="biography-loading" role="status"><p>Loading the full source biography</p>
    <p>You can still read the excerpt, browse the recorded places or open the original OHP page.</p></div>`;
}

export function biographyDialog(journey) {
  return researchDialog("biography-dialog", journey.name, `
    <div data-biography-content>${biographyContent(journey)}</div>
    <div class="biography-source-actions">
      <a class="link" href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">Read at OHP ${icon("external-link")}</a>
      <button class="link" data-act="print-account"${journey.biographyState === "ready" ? "" : " disabled"}>${icon("printer")} Print biography</button>
    </div>`);
}

function flagImage(flag, className = "") {
  return `<span class="flag-image-wrap ${className}"><img data-flag-image src="${esc(siteResource(flag.src))}"
    alt="${esc(flag.label)}" loading="lazy" decoding="async"><span class="flag-image-fallback" hidden>Image unavailable</span></span>`;
}

function flagPeriods(records) {
  return `<ol class="flag-periods">${records.map(flag => `<li>
    ${flagImage(flag)}
    <div><h4>${esc(readableFlagText(flag.label))}</h4>
      <p class="flag-period-dates">${flag.start ? `${esc(flag.start)}${flag.end ? ` until ${esc(flag.end)}` : " onward"}` : "Dates not established"}</p>
      <p>${esc(readableFlagText(flag.note || ""))}</p>
      <a href="${esc(flag.sourceUrl)}" target="_blank" rel="noopener">Source and dates ${icon("external-link")}</a>
      <span class="flag-credit">${esc(flag.credit)} · ${flag.licenseUrl
        ? `<a href="${esc(flag.licenseUrl)}" target="_blank" rel="noopener">${esc(flag.license)}</a>` : esc(flag.license)}</span>
    </div></li>`).join("")}</ol>`;
}

export function flagBrowser(year, minimum, maximum) {
  return researchDialog("flag-browser", "Country flags", `
    <p class="research-dialog-intro">Choose Current to see today's reference flags, or choose a year for documented historical designs.
      You can browse flags here even when they do not fit on the map.</p>
    <div class="flag-browser-controls">
      <label>Find a flag<input id="flag-directory-search" class="search-input" type="search"
        placeholder="Country or historical name" autocomplete="off" autofocus></label>
      <label>Period<select id="flag-directory-year" aria-label="Flag year or current references"><option value="current">Current</option>${Array.from({ length: maximum - minimum + 1 }, (_, index) => minimum + index)
        .map(value => `<option value="${value}"${value === year ? " selected" : ""}>${value}</option>`).join("")}</select></label>
    </div>
    <p class="directory-count" data-flag-count role="status"></p>
    <div data-flag-directory></div>
    <p class="directory-empty" data-flag-empty hidden>No names match. Try another spelling or clear the search.</p>
    <p class="research-dialog-note">The atlas shows the middle of each year. It leaves out designs when their transition dates are uncertain.
      A missing entry is a gap in this catalogue, not evidence that a country had no flag.
      Flags do not establish sovereignty or territorial control.
      ${FLAG_CATALOGUE_META.unavailableArtwork ? "Some historical images could not be obtained or were left out after checks." : ""}</p>`);
}

export function flagDirectory(entries, year, status, current = false) {
  return `${status !== "ready" ? `<p class="directory-empty" role="status">${status === "error"
    ? `The historical country outlines could not load. You can still browse the recorded flag designs below.`
    : "The historical country outlines are loading. You can browse the recorded flag designs below."}
    ${status === "error" ? '<button class="link" data-act="retry-history">Retry country outlines</button>' : ""}</p>` : ""}
    <div class="flag-directory-list">${entries.filter(country => !current || country.currentCountry).map(country => {
      const preview = current ? country.currentReference : country.flag;
      return `
      <details class="flag-directory-entry" name="flag-directory-country" data-flag-row
        data-flag-name="${esc(country.name)}" data-flag-search="${esc(normalizeSearch(country.names.join(" ")))}"
        data-flag-available="${Boolean(preview && !preview.neutralIdentifier)}">
        <summary data-flag-summary="${esc(country.name)}" tabindex="-1">
          ${preview ? flagImage(preview, "flag-directory-preview") : `<span class="flag-directory-placeholder" aria-hidden="true">${icon("flag")}</span>`}
          <span><strong>${esc(country.name)}</strong><small>${current
            ? (preview ? "Current reference image" : country.name === "Antarctica" ? "No national flag" : "Current image unavailable")
            : country.flag ? (country.flag.neutralIdentifier ? "Neutral historical identifier" : `Dated design for ${year}`)
            : `No dated design for ${year}`}</small></span>${icon("chevron")}
        </summary>
        <div class="flag-directory-detail">
          ${country.note ? `<p class="flag-note">${esc(country.note)}</p>` : ""}
          ${current ? '<p class="flag-note">Current reference images are not assigned to earlier dates. Choose a year to see the design documented for it.</p>' : ""}
          ${country.controller ? `<button class="link flag-view-map" data-flag-controller="${esc(country.controller)}" data-flag-year="${year}">View this administration on the ${year} map ${icon("arrow-right")}</button>`
            : `<p class="flag-note">No matching administration outline is available in this map for ${year}.</p>`}
          ${country.history.length ? `<h3>Flag history</h3>${flagPeriods(country.history)}`
            : '<p class="flag-note">No dated flag history is recorded here yet.</p>'}
          ${country.currentReference && !country.history.some(flag => flag.src === country.currentReference.src)
            ? `<h3>Current reference image</h3><p class="flag-note">This reference is not assigned to historical dates without a documented use period.</p>
              ${flagPeriods([country.currentReference])}` : ""}
        </div>
      </details>`;
    }).join("")}</div>`;
}

export function placeBrowser(store, state) {
  const places = collectionPlaces(store, state);
  const precision = { city: "City reference", site: "Site reference", country: "Country reference",
    region: "Regional reference", mixed: "Mixed precision", unknown: "Location needs review" };
  return researchDialog("place-browser", "Place index", `
    <p class="research-dialog-intro">Browse places named in your current results${state.savedOnly ? ", within your saved accounts" : state.sharedIds ? ", within this reading list" : ""}${state.captionedOnly ? ", among accounts with listed captions" : ""}.
      Your search and community filters still apply. Choosing a name replaces the current place filter.</p>
    <label class="sr-only" for="place-directory-search">Search recorded place names and original spellings</label>
    <input id="place-directory-search" class="search-input" type="search" placeholder="Search place names" autocomplete="off" autofocus>
    <p class="directory-count" data-directory-count role="status">${places.length} place names</p>
    <ul class="place-directory-list" aria-label="Recorded place names">${places.map(place => `
      <li data-directory-row data-place-search="${esc(place.searchText)}">
        <button data-browse-place="${esc(place.name)}" tabindex="-1">
          <span><strong>${esc(place.name)}</strong><small>${esc(precision[place.precision] || "Map reference")}</small></span>
          <span class="directory-account-count">${place.count} ${place.count === 1 ? "account" : "accounts"}</span>
        </button>
      </li>`).join("")}</ul>
    <p class="directory-empty" data-directory-empty${places.length ? " hidden" : ""}>${places.length
      ? "No place names match. Try an original spelling or clear the search."
      : "No place names are available with these filters. Close the index and reset the collection filters to browse more accounts."}</p>
    <p class="research-dialog-note">The count tells you how many accounts name a place. It does not confirm that those people were there.</p>`);
}

export function readingListDialog(journeys, url, error = "") {
  return researchDialog("reading-list-dialog", "Share a reading list", `
    <p class="research-dialog-intro">This link shares all ${journeys.length} ${journeys.length === 1 ? "account" : "accounts"} matching your filters, including results you have not scrolled to.
      Anyone with the link can open the list. It does not include your other saved accounts.</p>
    <ul class="reading-list-preview">${journeys.slice(0, 5).map(journey => `<li>${esc(journey.name)}</li>`).join("")}
      ${journeys.length > 5 ? `<li class="reading-list-more">And ${journeys.length - 5} more accounts</li>` : ""}</ul>
    <p class="reference-status" data-reading-list-status role="status">${esc(error)}</p>
    <label for="reading-list-address">Link to this selection</label>
    <textarea id="reading-list-address" rows="3" readonly>${esc(url)}</textarea>
    <div class="research-dialog-actions">
      <button class="btn btn-primary" data-act="copy-reading-list"${url ? "" : " disabled"}>${icon("copy")} Copy list link</button>
      <button class="link" data-act="download-shared-sources">Download citations</button>
      <button class="link" data-act="print-reading-list">${icon("printer")} Print list</button>
    </div>
    <p class="research-dialog-note">Recipients choose whether to save these accounts. Opening a link never changes their private list.</p>`);
}

export function saveButton(journey, state, compact = false) {
  const saved = state.savedIds.has(journey.id);
  const label = saved ? `Remove ${journey.name} from saved accounts` : `Save ${journey.name} for later`;
  return `<button class="${compact ? "rail-save" : "account-save"}" data-save-id="${esc(journey.id)}"
    aria-pressed="${saved}" aria-label="${esc(label)}" title="${esc(label)}">
    ${icon("bookmark")}${compact ? "" : `<span>${saved ? "Saved account" : "Save account"}</span>`}</button>`;
}

function railCard(j, state) {
  const isSel = j.id === state.selectedId;
  const col = GROUP_COLOR[j.group] || C.accent;
  const matches = state.query ? searchMatchLabels(j, state.query) : [];
  return `<div class="rail-entry${isSel ? " sel" : ""}" role="listitem">
    <button class="rail-card ${isSel ? "sel" : ""}" data-survivor="${esc(j.id)}" aria-pressed="${isSel}">
    ${profileMedal(j, col)}
    <span class="rail-text">
      <span class="rail-name">${esc(j.name)}</span>
      <span class="rail-intro">${profileMeta(j) || esc(j.group)}</span>
      ${matches.length ? `<span class="rail-match">Matches: ${matches.map(esc).join(" · ")}</span>` : ""}
    </span></button>${saveButton(j, state, true)}</div>`;
}

export function resultNavigation(store, state) {
  const results = collectionResults(store, state);
  const index = results.findIndex((journey) => journey.id === state.selectedId);
  if (index < 0) return `<p class="outside-results">This account is outside the current ${state.savedOnly ? "saved " : ""}results.</p>`;
  if (results.length === 1) return "";
  return `<button data-act="previous-account"${index ? ` title="${esc(results[index - 1].name)}"` : " disabled"} aria-label="Previous account in results">${icon("arrow-right")}<span>Previous</span></button>
    <span class="result-position">${index + 1} of ${results.length} ${state.savedOnly ? "saved " : ""}${results.length === 1 ? "result" : "results"}</span>
    <button data-act="next-account"${index < results.length - 1 ? ` title="${esc(results[index + 1].name)}"` : " disabled"} aria-label="Next account in results"><span>Next</span>${icon("arrow-right")}</button>`;
}

function accountTools(journey, state) {
  return `<section class="account-tools" aria-label="Keep or reference this account">
    <div class="account-tool-row">${saveButton(journey, state)}
      <button data-act="toggle-account-reference" aria-expanded="false" aria-controls="account-reference">${icon("share")} Share &amp; cite</button>
      <button data-act="print-account" aria-label="Print account"${journey.detailState === "ready" ? "" : " disabled"}>${icon("printer")} Print</button>
    </div>
    <p class="saved-feedback" data-account-saved-feedback role="status"${state.savedError ? "" : " hidden"}>${esc(state.savedError || "")}</p>
    <div class="account-reference" id="account-reference" hidden>
      <div class="reference-heading"><h3>Share &amp; cite</h3>
        <button data-act="close-account-reference" aria-label="Close sharing and citation tools">${icon("close")}</button></div>
      <label for="account-link">Link to this account</label>
      <div class="reference-copy-row"><input id="account-link" readonly value="${esc(accountLink(journey, location.href))}">
        <button data-copy-account="link" aria-label="Copy account link">${icon("copy")} Copy link</button></div>
      <label for="account-citation">Citation for the original OHP page</label>
      <textarea id="account-citation" rows="5" readonly>${esc(accountCitation(journey, state.citationDate))}</textarea>
      <button class="citation-copy" data-copy-account="citation">${icon("copy")} Copy citation</button>
      <p class="reference-note">This citation refers to the source page, not a verbatim transcript. It does not infer an interview date.</p>
      <p class="reference-status" data-account-copy-status role="status"></p>
    </div>
  </section>`;
}

export function panel(store, state) {
  const j = store.byId.get(state.selectedId);
  if (!j) return "";
  const col = GROUP_COLOR[j.group] || C.accent;
  const wp = j.waypoints;
  const ready = j.detailState === "ready";
  const passages = accountSourcePassages(j);
  const steps = wp.map((w, i) => {
    const passage = passages.get(w);
    return `<li class="recorded-place">
      <button class="place-focus" data-place-step="${i}" aria-pressed="${state.activePlaceIndex === i}">
        <span class="place-order">${i + 1}</span>
        <span><span class="step-place">${esc(w.canonical)}</span><span class="step-meta">${esc(wpMeta(w))}</span></span>
        ${icon("arrow-right")}
      </button>
      <p class="place-precision"><span class="reference-kind">${!w.verified && w.evidenceScope !== "personal" ? "Needs review" : ["country", "region", "unknown"].includes(w.locationPrecision) ? "Broad area" : "Route reference"}</span>
        ${esc(precisionLabel(w))}${w.locationNote ? `. ${esc(w.locationNote)}` : "."}</p>
      ${passage ? `<p class="place-account">${esc(passage)}</p>` : ""}
      ${w.locationSourceUrl ? `<a class="location-source" href="${esc(w.locationSourceUrl)}" target="_blank" rel="noopener">Location reference ${icon("external-link")}</a>` : ""}
      ${w.humanReview ? `<details class="review-audit"><summary>${!w.verified && w.humanReview.action === "approve" ? "Prior review needs rechecking" : "Human review record"} ${icon("chevron")}</summary>
        <p>${esc(w.humanReview.reviewer)}, ${esc(w.humanReview.reviewed_at)}. ${esc(w.humanReview.rationale)}</p>
        <a href="${esc(w.humanReview.source_url)}" target="_blank" rel="noopener">Review evidence ${icon("external-link")}</a></details>` : ""}
      <div class="reference-actions" data-reference-actions="${i}"${state.activePlaceIndex === i ? "" : " hidden"}>
        <button class="link" data-copy-reference="${i}"${ready ? "" : " disabled"}>${icon("copy")} Copy reference link</button>
        <span data-reference-copy-status="${i}" role="status"></span>
        <label class="sr-only" for="reference-address-${i}">Link to this source reference</label>
        <textarea id="reference-address-${i}" rows="2" readonly hidden></textarea>
      </div>
    </li>`;
  }).join("");
  const tags = (j.conflicts.concat(j.themes)).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const reviewed = j.reviewStatus === "reviewed";
  const sections = [
    ["profile-story", "Account"],
    ...(j.media.images.length || j.media.imageReferences.length ? [["profile-photographs", "Photographs"]] : []),
    ...(ready && (j.videoCount || j.media.videos.length || state.chapterId || state.chapterMessage) ? [["profile-interviews", "Interview"]] : []),
    ["profile-places", "Places"],
  ];
  return `
    <aside class="panel scroll" aria-labelledby="profile-name" data-profile-state="${j.detailState}"
      aria-busy="${!ready && j.detailState !== "error"}">
      <div class="profile-toolbar">
        <div class="panel-topline"><button class="link" data-act="clear" aria-label="Back to the collection">
          <span class="profile-back-long">Back to the collection</span><span class="profile-back-short">Collection</span></button>
          <span class="profile-current-name" title="${esc(j.name)}" aria-hidden="true">${esc(j.name)}</span>
          <button class="reader-toggle" data-act="expand-reader" aria-label="Expand account reader"><span data-reader-label>Expand</span>${icon("fit")}</button>
          <button class="panel-close" data-act="clear" aria-label="Close profile">${icon("close")}</button></div>
        <nav class="profile-nav" aria-label="In this account">${sections.map(([id, label]) =>
          `<button data-profile-section="${id}" aria-controls="${id}">${label}</button>`).join("")}</nav>
      </div>
      <div class="profile-heading">
        ${profileMedal(j, col, true)}
        <div>
          <h2 class="serif-lg" id="profile-name" tabindex="-1">${esc(j.name)}</h2>
          <div class="panel-group" style="--gc:${col}">${esc(j.group)}</div>
          <div class="panel-meta">${j.born ? `Born ${esc(j.born)}.` : ""}</div>
        </div>
      </div>
      <nav class="result-navigation" data-result-navigation aria-label="Browse matching accounts">${resultNavigation(store, state)}</nav>
      <p class="profile-route-status">${esc(profileRouteStatus(j))}</p>
      <div class="reference-notice" data-reference-notice${state.referenceMessage ? "" : " hidden"}>${referenceNotice(state)}</div>
      ${!reviewed ? '<p class="account-review-note">This map record has not been fully reviewed. Markers show places named in the source; they do not confirm that the person was there.</p>' : ""}
      ${accountTools(j, state)}
      <div class="profile-actions">
        ${ready && j.videoCount ? `<button class="interview-action" data-act="show-interviews">View interview chapters ${icon("arrow-right")}</button>` : ""}
        <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Read the original OHP page ${icon("external-link")}</a>
      </div>
      <div class="profile-content">
      <section id="profile-story" tabindex="-1" aria-label="Account">
        ${ready ? `<p class="biography-excerpt-label">Brief excerpt</p>
          <p class="bio">${esc(j.bio || "The original OHP page contains this person's account.")}</p>
          <button class="link biography-open" data-act="read-full-biography" aria-haspopup="dialog">Read full source biography ${icon("arrow-right")}</button>`
          : `<div class="profile-loading" role="status">
            <h3>${j.detailState === "error" ? "Account details could not load" : "Loading this account"}</h3>
            <p>${j.detailState === "error" ? "You can still use the map. Try again to load the biography and interview chapters, or open the original OHP page." : "Loading this account's biography, photographs and interview chapters. Other accounts load when you open them."}</p>
            ${j.detailState === "error" ? '<div class="profile-recovery"><button class="link" data-act="retry-profile">Try again</button><button class="link" data-act="reload-collection">Reload collection</button></div>' : ""}
          </div>`}
      </section>
      ${ready ? profileGallery(j) : ""}
      ${ready ? profileInterviews(j, state) : ""}
      ${j.serviceYear ? `<details class="related-context"><summary>Historical context and maps ${icon("chevron")}</summary>
        <p class="section-note">These sources describe the period. They are separate from ${esc(j.name)}'s own account.</p>
        ${contextResources(j.serviceYear)}</details>` : ""}
      <section class="profile-places" id="profile-places" tabindex="-1" aria-labelledby="recorded-places-title">
        <h3 id="recorded-places-title">Recorded places</h3>
        <p class="section-note">${wp.length
          ? "These are the places named in this account. The map distinguishes broad areas and mentions that need review from cities and sites linked to this person in the source."
          : "This version of the account has no mapped places. You can still read the biography and open the interview. A person's community category does not tell us where they travelled."}</p>
        ${accountMapOverview(j)}
        ${wp.length ? `<ol class="journey">${steps}</ol>` : ""}
      </section>
      ${contextualPlaces(j)}
      <div data-related-reading>${ready ? relatedReading(store, state) : ""}</div>
      ${ready ? `<details class="review-tools"><summary>Review these references ${icon("chevron")}</summary>
        <p>Download the source material for a student or teacher to compare with the original interview. A trusted project maintainer prepares the worksheet and imports each reviewer's decisions. This page cannot approve or verify references.</p>
        <button class="link" data-act="download-review">Download source for review</button></details>` : ""}
      <div class="tags">${tags}</div>
      ${reviewed ? `<div class="ver" style="color:${C.verified}"><span class="ver-dot"></span>Checked against the interview</div>` : ""}
      </div>
      <nav class="result-navigation result-navigation-end" data-result-navigation aria-label="Continue through matching accounts">${resultNavigation(store, state)}</nav>
    </aside>`;
}

export function accountMapOverview(journey) {
  const counts = evidenceCounts(journey);
  if (!counts.mapped) return `<div class="account-map-unavailable">
    <p>No places from this account have been mapped yet.</p>
    <a class="link" href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">Find places in the original OHP account ${icon("external-link")}</a>
  </div>`;
  const routeLocations = new Set(journey.routeWaypoints.filter(point =>
    Number.isFinite(point.lng) && Number.isFinite(point.lat) &&
    (point.evidenceScope === "personal" || point.verified) && ["city", "site"].includes(point.locationPrecision))
    .map(point => `${point.lng},${point.lat}`));
  return `<figure class="account-map-overview">
    <svg class="mini" viewBox="0 0 340 190" role="img" aria-label="Map of ${esc(journey.name)}'s recorded places" data-mini></svg>
    <figcaption class="mini-cap"><span>Current borders · ${counts.mapped} ${counts.mapped === 1 ? "recorded reference" : "recorded references"}</span>
      ${routeLocations.size > 1 ? "Lines connect cities and sites linked to this person in the source. They do not show exact travel paths."
        : "Markers show places named in the source. There is not enough evidence to connect them as a journey."}</figcaption>
    <button class="link mini-map-open" data-act="show-explore-map">Open larger map ${icon("arrow-right")}</button>
  </figure>`;
}

export function referenceNotice(state) {
  if (!state.referenceMessage) return "";
  return `<p role="status">${esc(state.referenceMessage)}</p>
    <button class="link" data-act="clear-reference">Show all references</button>`;
}

export function relatedReading(store, state) {
  const matches = relatedAccounts(store, state);
  if (!matches.length) return "";
  return `<section class="related-reading" aria-labelledby="related-reading-title">
    <h3 id="related-reading-title">Other accounts naming these places</h3>
    <p>These accounts in your current results name some of the same cities or sites. That does not mean the people travelled together or met.</p>
    <ul>${matches.map(({ journey, places }) => `<li>
      <button data-related-account="${esc(journey.id)}">
        ${profileMedal(journey, GROUP_COLOR[journey.group] || C.accent)}
        <span><strong>${esc(journey.name)}</strong><small>Also names ${esc(places.slice(0, 2).join("; "))}${places.length > 2 ? `, and ${places.length - 2} more` : ""}.</small></span>
        ${icon("arrow-right")}
      </button>
    </li>`).join("")}</ul>
  </section>`;
}

function profileRouteStatus(journey) {
  if (!journey.waypoints.length) return "No places have been mapped for this account.";
  const counts = evidenceCounts(journey);
  return `${counts.total} matched place ${counts.total === 1 ? "mention" : "mentions"}: ${counts.route} route references, ${counts.broad} broad areas, ${counts.review} to review. ` +
    (counts.route > 1 ? "Lines connect only cities and sites linked to this person in the source, not exact travel paths."
      : "There are not enough city/site references to draw a route.") +
    (journey.unplacedCount ? ` ${journey.unplacedCount} other automatically extracted place mentions have not been mapped.` : "");
}

export function exploreMapCaption(store, state, historyReady = true) {
  const place = store.byId.get(state.selectedId)?.waypoints[state.activePlaceIndex];
  const year = place?.historyYear;
  const dated = historyReady && year >= store.time.min && year <= store.time.max;
  return `<strong>${dated ? `${year} borders` : "Current borders"}</strong>${place
    ? `<span>${esc(place.canonical)}</span>` : ""}`;
}

function boundaryNotice() {
  return `<div class="boundary-notice" data-boundary-notice role="status" hidden>
    <p data-boundary-message></p><button class="link" data-act="retry-history" hidden>Try again</button>
  </div>`;
}

function sourcePassage(value) {
  const text = String(value || "").trim().replace(/\s+/g, " ");
  return /^[\p{Lu}0-9"'(\u201c\u2018]/u.test(text) && /[.!?][\u201d\u2019"')\]]*$/.test(text) ? text : "";
}

function accountSourcePassages(journey) {
  const passages = new Map(), used = new Set();
  for (const place of journey.waypoints) {
    const passage = sourcePassage(place.quote);
    if (passage && !used.has(passage) && !journey.bio.includes(passage)) {
      passages.set(place, passage);
      used.add(passage);
    }
  }
  return passages;
}

function contextualPlaces(journey, printing = false) {
  if (!journey.contextualPlaces.length) return "";
  const reasons = {
    "ancestor-only": "Family background",
    "ancestor-origin": "Family background",
    "historical-event": "Historical context",
    "military-unit-name": "Military unit name",
    comparison: "Comparison in the source",
  };
  const passages = new Map();
  for (const [index, place] of journey.contextualPlaces.entries()) {
    const quote = sourcePassage(place.quote);
    const key = `${place.evidenceReason}|${quote || place.canonical}`;
    if (!passages.has(key)) passages.set(key, { places: [], indices: [], reason: place.evidenceReason, quote });
    passages.get(key).places.push(place.canonical);
    passages.get(key).indices.push(index);
  }
  const wrapper = printing ? "section" : "details", heading = printing ? "h2" : "summary";
  return `<${wrapper} class="contextual-places">
    <${heading}>Other places in the source (${journey.contextualPlaces.length}) ${printing ? "" : icon("chevron")}</${heading}>
    <p class="section-note">The source mentions these places when discussing other people or background information. They stay in the account but are not shown as stops on this person's route.</p>
    <ul>${[...passages.values()].map((passage) => `<li data-context-places="${passage.indices.join(" ")}" tabindex="-1">
      <strong>${esc(passage.places.join("; "))}</strong>
      <span>${esc(reasons[passage.reason] || "Source context")}</span>
      ${passage.quote ? `<p>${esc(passage.quote)}</p>` : ""}
    </li>`).join("")}</ul>
  </${wrapper}>`;
}

export function printAccount(journey, address, accessed = new Date()) {
  const ready = journey.detailState === "ready";
  const fullBiography = ready && journey.biographyState === "ready" ? journey.fullBiography : "";
  const biography = fullBiography || journey.bio;
  const portrait = ready ? clearedPortrait(journey) : null;
  const passages = accountSourcePassages(journey);
  const reviewed = journey.reviewStatus === "reviewed";
  return `<article class="print-account">
    <header class="print-header">
      ${portrait ? `<figure class="print-portrait"><img src="${esc(siteResource(portrait))}" alt="${esc(journey.name)}">
        <figcaption>${esc(journey.portraitRights || "Crestwood Oral History Project")}</figcaption></figure>` : ""}
      <p class="print-kicker">Crestwood Oral History Project · Account reading sheet</p>
      <h1>${esc(journey.name)}</h1><p>${esc(journey.group)}${journey.born ? ` · Born ${esc(journey.born)}` : ""}</p>
      <p class="print-citation">${esc(accountCitation(journey, accessed))}</p>
      <p class="print-link">Interactive account: <a href="${esc(accountLink(journey, address))}">${esc(accountLink(journey, address))}</a></p>
    </header>
    <p class="print-caveat">${reviewed ? "This map record is marked reviewed. Coordinates are approximate, and connections are not exact travel paths."
      : "This map record has not been fully reviewed. It shows places named in the source, not confirmed presence or exact travel paths."}
      This sheet uses a public source biography or excerpt, not a verbatim interview transcript.</p>
    ${ready ? `<section><h2>${fullBiography ? "Public OHP biography" : "Public OHP summary excerpt"}</h2>
        <p class="print-biography">${esc(biography || "No public summary is available in this version of the archive. Read the original OHP page.")}</p>
        ${fullBiography && journey.bio && !fullBiography.includes(journey.bio) ? `<h3>Collection introduction</h3><p>${esc(journey.bio)}</p>` : ""}
        ${!fullBiography ? '<p class="print-source-note">This is the short collection excerpt. Open Read full source biography before printing to include the longer source text.</p>' : ""}
      </section>
      <section><h2>Interview material</h2><p>${journey.videoCount} recorded ${journey.videoCount === 1 ? "chapter" : "chapters"}.
        ${journey.captionedVideoCount} ${journey.captionedVideoCount === 1 ? "chapter has" : "chapters have"} listed captions.
        Playback and caption access depend on the video provider. Open the original OHP page for the interview.</p>
        <p class="print-link"><a href="${esc(journey.archiveUrl)}">${esc(journey.archiveUrl)}</a></p></section>
      <section><h2>Recorded place references</h2><p>${esc(profileRouteStatus(journey))}</p>
        <ol class="print-references">${journey.waypoints.map(place => `<li>
          <h3>${esc(place.canonical)}</h3><p>${esc(wpMeta(place))}</p>
          <p>${esc(precisionLabel(place))}${place.locationNote ? `. ${esc(place.locationNote)}` : "."}
            ${place.verified ? "Human-checked reference." : place.evidenceScope === "personal"
              ? "The source links this place to the person, but it is not currently verified by a reviewer." : "This mention needs review and does not confirm that the person was there."}</p>
          ${passages.get(place) ? `<blockquote>${esc(passages.get(place))}</blockquote>` : ""}
          ${place.locationSourceUrl ? `<p class="print-link">Location reference: <a href="${esc(place.locationSourceUrl)}">${esc(place.locationSourceUrl)}</a></p>` : ""}
          ${place.humanReview ? `<p>${!place.verified && place.humanReview.action === "approve" ? "Prior review needs rechecking" : "Human review"}:
            ${esc(place.humanReview.reviewer)}, ${esc(place.humanReview.reviewed_at)}. ${esc(place.humanReview.rationale)}</p>
            <p class="print-link"><a href="${esc(place.humanReview.source_url)}">${esc(place.humanReview.source_url)}</a></p>` : ""}
        </li>`).join("")}</ol>
      </section>${contextualPlaces(journey, true)}`
      : `<p class="print-incomplete">The complete account details have not loaded. This is not a complete reading sheet. Reload the interactive account or read the original OHP page before printing again.</p>`}
    <footer class="print-footer">${esc(journey.name)} · Crestwood Oral History Project</footer>
  </article>`;
}

export function printReadingList(journeys, address, accessed = new Date(), missing = 0) {
  return `<article class="print-reading-list"><header class="print-header">
    <p class="print-kicker">Crestwood Oral History Project · Reading list</p>
    <h1>Sources for ${journeys.length} ${journeys.length === 1 ? "account" : "accounts"}</h1>
    <p>These are the accounts in the selected reading list, in collection order.</p></header>
    ${missing ? `<p class="print-caveat">${missing} ${missing === 1 ? "account in the shared link is" : "accounts in the shared link are"} not available in this version of the archive and cannot be cited here.</p>` : ""}
    <ol class="print-references">${journeys.map(journey => `<li><h2>${esc(journey.name)}</h2>
      <p>${esc(accountCitation(journey, accessed))}</p>
      <p class="print-link">Interactive account: <a href="${esc(accountLink(journey, address))}">${esc(accountLink(journey, address))}</a></p>
    </li>`).join("")}</ol>
    <p class="print-caveat">These citations refer to original OHP source pages, not verbatim transcripts.
      The citations do not infer interview dates. Mapped references may still need human review.</p>
    <footer class="print-footer">Reading list · ${journeys.length} accounts · Crestwood Oral History Project</footer></article>`;
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
    <a href="${esc(siteResource(image.fullUrl || image.sourceUrl || image.url))}" target="_blank" rel="noopener" aria-label="Open photograph from ${esc(journey.name)}'s OHP page">
      <img src="${esc(siteResource(image.fullUrl || (image.primary ? image.sourceUrl : null) || image.url))}" alt="${esc(image.caption || `Photograph from ${journey.name}'s OHP gallery`)}" loading="lazy" decoding="async">
    </a>
    <figcaption>${esc(image.caption || `This photograph appears on ${journey.name}'s OHP page.`)}
      <span>${esc(image.credit)}</span></figcaption>
  </figure>`);
  return `<section class="profile-gallery" id="profile-photographs" tabindex="-1" aria-label="Photographs from the original account">
    ${figures[0] || ""}
    ${figures.length > 1 ? `<details class="more-photographs">
      <summary>View ${figures.length - 1} more ${figures.length === 2 ? "photograph" : "photographs"} ${icon("chevron")}</summary>
      <div class="photo-list">${figures.slice(1).join("")}</div>
    </details>` : ""}
    ${references.length ? `<details class="original-gallery">
      <summary>More photographs on OHP (${references.length}) ${icon("chevron")}</summary>
      <p class="section-note">These additional images appear in the original gallery. Their individual reuse rights have not been confirmed, so the links open the images at their source.</p>
      <ul>${references.map((image, index) => `<li><a href="${esc(image.sourceUrl || image.url)}" target="_blank" rel="noopener">${esc(
        image.caption && !/^Photograph from |^OHP archive photograph/i.test(image.caption)
          ? image.caption : `Open source photograph ${index + 1}`,
      )} ${icon("external-link")}</a></li>`).join("")}</ul>
    </details>` : ""}
  </section>`;
}

export function chapterTools(journey, state) {
  const video = journey.media.videos.find(entry => entry.id === state.chapterId);
  const message = state.chapterMessage || (state.chapterId && !video
    ? "This chapter is no longer listed in this account. The biography and other interview material remain available." : "");
  return `${message ? `<p class="chapter-notice" data-chapter-notice tabindex="-1" role="status">${esc(message)}</p>` : ""}
    ${video || message ? `<div class="chapter-actions">
      ${video ? `<button class="link" data-act="copy-chapter-link">${icon("share")} Copy chapter link</button>` : ""}
      <button class="link" data-act="clear-chapter">Clear chapter selection</button>
    </div>` : ""}
    <p class="reference-status" data-chapter-copy-status role="status"></p>
    <input class="chapter-address" data-chapter-address aria-label="Link to the selected interview chapter" readonly hidden>`;
}

function profileInterviews(journey, state) {
  if (!journey.videoCount && !journey.media.videos.length && !state.chapterId && !state.chapterMessage) return "";
  const chapters = journey.media.videos.map((video, index) => {
    const playable = playerURL(video);
    const chapterTitle = video.title.replace(new RegExp(`^${index + 1}[.)]\\s*`), "");
    const title = `<span class="video-order">${index + 1}</span><span>${esc(chapterTitle)}
      <small>${esc(captionStatus(video))}</small></span>${icon(playable ? "play" : "external-link")}`;
    return `<li>${playable
      ? `<button class="video-chapter" data-video="${esc(video.id)}" data-chapter-id="${esc(video.id)}"${state.chapterId === video.id ? ' aria-current="true"' : ""}>${title}</button>`
      : `<a class="video-chapter" data-chapter-id="${esc(video.id)}"${state.chapterId === video.id ? ' aria-current="true"' : ""} href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">${title}</a>`}</li>`;
  });
  const inlineCount = journey.media.videos.filter((video) => playerURL(video)).length;
  return `<section class="profile-interviews" id="profile-interviews" tabindex="-1" aria-labelledby="interviews-title">
    <h3 id="interviews-title" tabindex="-1">The interview</h3>
    ${recordingMeta(journey)}
    <p class="section-note">These chapters come from ${esc(journey.name)}'s OHP page. ${inlineCount
      ? "Choose a play button to load a video. Chapters marked with an external-link icon open the original page instead."
      : "These chapters cannot play here. The links open the original OHP page, where access may also be restricted."}</p>
    <div class="interview-player" data-player hidden>
      <div class="player-heading"><strong data-player-title></strong>
        <button data-act="close-video" aria-label="Close video">${icon("close")}</button></div>
      <div class="player-frame" data-player-frame></div>
      <p class="player-note">If Vimeo cannot play this recording here, <a href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">open it on the OHP page</a>.</p>
    </div>
    <div class="chapter-tools" data-chapter-tools>${chapterTools(journey, state)}</div>
    ${chapters.length ? `<ol class="video-chapters">${chapters.slice(0, 5).join("")}</ol>
      ${chapters.length > 5 ? `<details class="more-videos"><summary>View all ${chapters.length} chapters ${icon("chevron")}</summary>
        <ol class="video-chapters" start="6">${chapters.slice(5).join("")}</ol></details>` : ""}`
      : `<a class="archive-link" href="${esc(journey.archiveUrl)}" target="_blank" rel="noopener">Open the interview chapters on OHP ${icon("external-link")}</a>`}
  </section>`;
}

function mapTools(expand = false) {
  return `<div class="map-tools" role="group" aria-label="Map controls">
    <button data-act="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button>
    <button data-act="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button>
    <button data-act="reset-map" aria-label="Fit map to view" title="Fit map to view">${icon("fit")}</button>
    ${expand ? `<button data-act="show-explore-map" aria-label="Open full map" title="Open full map">${icon("map")}</button>` : ""}
  </div>`;
}

function mapLegend(view, context = null) {
  return `<details class="map-legend">
    <summary>Map key ${icon("chevron")}</summary>
    <div><p>${view === "explore" ? "A marker locates a named reference, not a person's exact position." : "Borders are dated source records, not exact front lines."}</p>
      <ul><li><i class="key-precise"></i>City or site linked to the person</li>
        <li><i class="key-broad"></i>Country or regional reference</li>
        <li><i class="key-review"></i>Mention needing review</li>
        <li><i class="key-route"></i>Connections supported by source references</li>
        ${view === "history" && context?.coalition_label ? `<li><i class="key-territory" style="background:${C.warCoalition}"></i>${esc(context.coalition_label)}</li>
          <li><i class="key-territory" style="background:${C.warOpposition}"></i>${esc(context.opposition_label)}</li>
          ${context.occupied.length ? `<li><i class="key-territory" style="background:${C.warOccupied}"></i>Occupied or contested</li>` : ""}` : ""}
      </ul>
      <p>${view === "explore" ? "Collection numbers count accounts naming a place; zoom in for nearby counts. Arrow keys reach every marker."
        : "Rings open dated accounts. Dashed territory borders mark overlapping alternatives."}</p>
    </div>
  </details>`;
}

function profileMedal(journey, color, large = false) {
  const portrait = profilePicture(journey);
  return `<span class="medal ${large ? "medal-lg" : ""}" style="--gc:${color}">
    <span class="avatar-initials">${esc(journey.initials)}</span>
    ${portrait ? `<img src="${esc(siteResource(portrait))}" alt="" loading="lazy" decoding="async">` : ""}
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
    const list = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1])
      .map(([c, n]) => `<li><button class="origin-choice" data-origin="${esc(c)}" aria-label="Explore ${n} accounts with routes starting in ${esc(c)}">
        <span class="oc-name">${esc(c)}</span><span class="oc-bar" aria-hidden="true"><span style="width:${Math.round(n / topOrigin[1] * 100)}%"></span></span>
        <span class="oc-n">${n}</span>${icon("arrow-right")}</button></li>`);
    return `
    <div class="ov ov-patterns is-origins">
      <h1 class="sr-only">Mapped route origins</h1>
      <div class="patterns-intro">
        <h2 class="serif-xl">Where the mapped routes begin</h2>
        <p class="lede sm">${topOrigin
          ? `<span class="accent">${esc(topOrigin[0])}</span> has the largest count, with <b>${topOrigin[1]}</b> mapped starting places.`
          : "No mapped starting places are available."}</p>
        ${toggle}
        <p class="section-note origin-instruction">Choose a country to read the matching accounts.</p>
        <ul class="origin-list">${list.slice(0, 9).join("")}</ul>
        ${list.length > 9 ? `<details class="more-origins"><summary>View all ${list.length} countries ${icon("chevron")}</summary>
          <ul class="origin-list">${list.slice(9).join("")}</ul></details>` : ""}
        <p class="cross-sub">Each count uses the first map reference linked to the person in their account. It is not necessarily their birthplace.
          A reference is counted only if it can be linked to a present-day country. Historical regions are not assigned to a modern country without supporting evidence.</p>
        <p class="cross-sub">This is a Toronto school's interview collection, not a representative survey. The people interviewed and places that can be matched shape these counts.</p>
        <div class="origin-scale" aria-label="Map shading: fewer to more starting references"><span>Fewer</span><i></i><span>More</span></div>
      </div>
      ${mapTools()}
    </div>`;
  }

  return `
  <div class="ov ov-patterns">
    <h1 class="sr-only">Historical atlas</h1>
    <div class="patterns-map-head">
      <h2>Territory and testimony</h2>
      <p class="history-scope">Explore dated borders and recorded accounts, ${store.time.min} to ${store.time.max}.</p>
      ${toggle}
      <div class="history-search-box">
      <form class="history-search" data-history-search>
        <label class="sr-only" for="history-location">Find a country or an OHP place</label>
        <input id="history-location" type="search" list="history-locations" placeholder="Find a country or recorded place" autocomplete="off"
          value="${esc(state.historyQuery || "")}" aria-describedby="history-search-status" data-country-search>
        <button type="submit" aria-label="Find location">${icon("search")}</button>
        <datalist id="history-locations"></datalist>
      </form>
      <div class="history-search-results" data-history-results${state.historyMatches.length ? "" : " hidden"}>
        ${historySearchResults(state.historyMatches, state.scrubYear)}
      </div>
      </div>
      <p class="history-search-status" id="history-search-status" data-search-status role="status">${esc(state.historySearchMessage || "")}</p>
      <div class="history-toolbar">
        <details class="history-settings">
          <summary aria-label="Map layers">${icon("layers")} Layers ${icon("chevron")}</summary>
          <div class="history-settings-body">
            <label><input type="checkbox" data-history-setting="flags"${state.historyFlags ? " checked" : ""}> Historical flags</label>
            <label><input type="checkbox" data-history-setting="labels"${state.historyLabels ? " checked" : ""}> Territory names</label>
            <label><input type="checkbox" data-history-setting="routes"${state.historyRoutes ? " checked" : ""}> Shared interview routes</label>
            <p class="section-note" data-route-availability>${store.corridorsForYear(state.scrubYear).length
              ? "Connections use only cities and sites linked to the person and dated to this year."
              : "No shared city or site routes have enough date evidence for this year."}</p>
            <label><input type="checkbox" data-history-setting="testimony"${state.historyTestimony ? " checked" : ""}> Recorded places</label>
            <label><input type="checkbox" data-history-setting="compare"${state.historyCompare ? " checked" : ""}> Compare with today's borders</label>
            <label class="history-speed-label">Timeline playback
              <select data-history-speed aria-label="Timeline playback speed">
                ${[1, 2, 4].map(speed => `<option value="${speed}"${state.historySpeed === speed ? " selected" : ""}>${speed === 1 ? "Normal speed" : `${speed} times faster`}</option>`).join("")}
              </select></label>
            <label class="history-range-label">Historical layer opacity
              <input type="range" min="0.2" max="1" step="0.05" value="${state.historyOpacity}" data-history-opacity aria-label="Historical layer opacity"></label>
            <label class="history-range-label" data-compare-control${state.historyCompare ? "" : " hidden"}>Move the comparison divider
              <input type="range" min="0" max="100" step="1" value="${state.historySplit}" data-history-split aria-label="Historical comparison divider"></label>
            <button class="compact-layer-switch" data-layer="origins">Show mapped route origins</button>
          </div>
        </details>
        <button class="history-flags-button" data-act="browse-flags" aria-label="Browse country flags"
          aria-haspopup="dialog" title="Browse country flags">${icon("flag")}<span>Flags</span></button>
        <button class="history-share" data-act="share-map" aria-label="Copy map link" title="Copy map link"
          aria-expanded="false" aria-controls="share-feedback">${icon("share")}</button>
        ${mapTools()}
      </div>
      <div class="share-feedback" id="share-feedback" role="region" aria-label="Share this map" hidden>
        <p class="history-share-status" data-share-status role="status"></p>
        <button class="share-close" data-act="close-share" aria-label="Close link sharing">${icon("close")}</button>
        <input class="share-address" data-share-address aria-label="Map link" readonly hidden>
      </div>
      ${boundaryNotice()}
    </div>
    <aside class="history-dossier" aria-label="Historical context and recorded places">
      <details class="history-context-disclosure" data-history-context${(state.historyContextOpen ?? window.innerWidth > 820) ? " open" : ""}>
        <summary><span class="context-title">Year context and sources</span><span class="context-return">Back to the map</span>
          <span data-year>${state.scrubYear}</span>${icon("chevron")}</summary>
        <div class="history-context-body" data-pattern-events tabindex="0">${patternsEvents(store, state)}</div>
      </details>
    </aside>
    <div class="scrubber">
      <div class="scrub-head">
        <button class="history-play" data-act="play-history" aria-label="${state.historyPlaying ? "Pause history" : "Play history"}" aria-pressed="${state.historyPlaying}">${icon(state.historyPlaying ? "pause" : "play")}</button>
        <span class="timeline-label">Historical timeline</span>
        <div class="year-navigation">
          <button data-act="prev-year" aria-label="Previous year"${state.scrubYear <= store.time.min ? " disabled" : ""}>${icon("arrow-right")}</button>
          <form data-year-form novalidate><label class="sr-only" for="history-year">Year</label>
            <input id="history-year" class="scrub-year" type="number" min="${store.time.min}" max="${store.time.max}" step="1" required value="${state.scrubYear}" data-year data-year-entry aria-label="Year">
          </form>
          <button data-act="next-year" aria-label="Next year"${state.scrubYear >= store.time.max ? " disabled" : ""}>${icon("arrow-right")}</button>
        </div>
      </div>
      <span class="sr-only" data-year-status role="status"></span>
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
    ${state.historyTestimony ? testimonyMoment(activeEvent, events, state, store) : ""}
    ${mapLegend("history", store.warAt(state.scrubYear))}
    <details class="history-sources">
      <summary>Original maps and historical context ${icon("chevron")}</summary>
      ${contextResources(state.scrubYear)}
      <p class="history-method">The atlas shows the middle of each year. Its outlines simplify the source records; they are not exact borders or daily front lines.
        Dashed outlines mark overlapping alternatives. A flag appears only when its documented design matches the selected date.</p>
      ${geometryAudit(store)}
    </details>`;
}

export function historySearchResults(matches, year) {
  if (!matches.length) return "";
  return `<ul aria-label="Matching map locations">${matches.slice(0, 8).map((match, index) =>
    `<li><button data-history-match="${index}"><span>${esc(match.name)}</span>
      <small>${match.kind === "country" ? `Historical territory in ${year}` : "Place in an OHP account"}</small>${icon("arrow-right")}</button></li>`).join("")}</ul>
    ${matches.length > 8 ? `<p>${matches.length - 8} more matches. Enter a more specific name to narrow the list.</p>` : ""}`;
}

function geometryAudit(store) {
  const quality = store.historicalIndex.quality;
  const current = quality && quality.input_sha256 === store.historicalIndex.geometry_sha256;
  return `<details class="geometry-audit">
    <summary>What the boundary audit checked ${icon("chevron")}</summary>
    ${current ? `<dl>
      <div><dt>Source outlines checked</dt><dd>${quality.features.toLocaleString("en-CA")}</dd></div>
      <div><dt>Missing or empty shapes</dt><dd>${quality.null + quality.empty}</dd></div>
      <div><dt>Invalid shapes</dt><dd>${quality.invalid}</dd></div>
      <div><dt>Overlapping alternative pairs</dt><dd>${quality.relationships.filter((entry) => entry.kind === "alternative").length}</dd></div>
    </dl><p>These checks test whether the shapes are valid, not whether the history is accurate.
      Exact duplicates are hidden; unresolved alternative outlines have dashed borders.</p>`
      : "<p>No matching technical audit is available for this version of the map.</p>"}
    <a class="catalogue-link" href="${siteResource("data/historical_boundary_quality.json")}" download>Download the technical audit (JSON) ${icon("external-link")}</a>
  </details>`;
}

function countryInspector(country, year) {
  const flag = country.flag;
  return `<section class="country-inspector">
    <button class="country-back" data-act="clear-country">${icon("arrow-right")} Back to ${year}</button>
    <div class="country-heading">${flag ? `<img class="country-flag" src="${esc(siteResource(flag.src))}" alt="${esc(flag.label)}" width="66" height="44">` : ""}
      <div><h3 tabindex="-1">${esc(country.name)}</h3><p>${country.alternativeRecords
        ? `Source outlines overlap in ${year}` : `Mapped in ${year}`}</p></div></div>
    ${flag ? `<details class="flag-details">    <summary>${flag.neutralIdentifier ? "Historical symbol and source" : "Flag dates and source"} ${icon("chevron")}</summary>
      <p class="flag-note">${esc(readableFlagText(flag.note || ""))}
      ${flag.start ? `<span class="flag-dates">The recorded use dates are ${esc(flag.start)}${flag.end ? ` to ${esc(flag.end)}` : " onward"}.</span>` : ""}
      <a href="${esc(flag.sourceUrl)}" target="_blank" rel="noopener">Flag source and dates ${icon("external-link")}</a>
      <span class="flag-credit">${esc(readableFlagText([flag.credit, flag.license].filter(Boolean).join(", ")))}</span></p></details>
      <p class="flag-summary">${esc(readableFlagText(flag.label))}</p>`
      : '<p class="flag-note">This catalogue has no documented flag design for this administration at the selected date.</p>'}
    ${country.flagHistory?.length ? `<details class="country-flag-history flag-details">
      <summary>Flag history (${country.flagHistory.length}) ${icon("chevron")}</summary>
      ${flagPeriods(country.flagHistory)}
    </details>` : ""}
    ${country.alternativeRecords ? `<p class="source-caution">${country.alternativeRecords} dated source outlines overlap for this name.
      Dashed borders mark these unverified alternatives.</p>` : ""}
    ${country.inferredGrouping ? '<p class="country-source">These records are grouped under an administration based on their source names. This does not independently verify who controlled the territory.</p>' : ""}
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
        <section><h2>Reading an account</h2><p>In Explore, you can read a person's account, view photographs,
          open interview chapters and find the places they name. History shows dated accounts
          alongside changing territories from 1914 to 2026.</p>
          <p>Search can combine a name with a place, or several places in one account. Every word
          must match; put an exact phrase in double quotes. Press Enter to browse the results.
          Search covers recorded names, places, periods and topics, not full biographies or transcripts.</p></section>
        <section><h2>From testimony to map</h2><p>Each route uses places named on a public OHP
          page. Historical names are matched to current locations, so &quot;Lemberg&quot;
          appears on the map as Lviv. When the source gives dates, they determine the order.</p>
          <p>Routes connect recorded places; they do not reconstruct the exact roads a person
          travelled. Approximate dates remain labelled as approximate.</p></section>
        <section><h2>Read alongside the original</h2><p>Profiles are built from public OHP
          summaries. Automated place matching has not been checked for every profile.
          Each account links to its original interview so you can read and listen in context.</p></section>
        <section><h2>The shape of this collection</h2><p>This is a Toronto school's interview
          archive, not a representative survey of history. Who students could interview,
          which places were named, and which names could be matched all shape the map.
          Country totals describe this collection, not populations or the scale of historical events.</p>
          <p>Automated confidence values describe the matching process. They are not measured probabilities that a claim is true.
          A human review decision is recorded separately and must cite its source.</p></section>
        <section><h2>Location and boundary accuracy</h2>
          <p>City and site markers are reference points, not exact positions within a building or town.
          Country and regional references cover broader areas. Uncertain dates and contextual mentions
          should not be read as verified stops in a person's journey.</p>
          <p>The historical outlines come from a simplified OpenHistoricalMap world tile. They show
          the middle of each year and can include overlapping source records. A valid shape
          does not prove that every border or administration is historically correct.</p>
          ${geometryAudit(store)}
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
            <p>Country names and ISO-code metadata: <a href="https://github.com/lipis/flag-icons/blob/v7.5.0/LICENSE"
              target="_blank" rel="noopener">flag-icons, copyright Panayiotis Lipiridis, MIT licence</a>.
              Image licences are recorded separately for each SVG.
              ${FLAG_CATALOGUE_META.unavailableArtwork ? "Some historical artwork is unavailable or has been left out after checks. Modern flags are not used to fill those gaps." : ""}</p>
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

export function notFound(kind) {
  const account = kind === "account";
  return `<div class="ov ov-not-found scroll">
    <section class="not-found-content" aria-labelledby="missing-title">
      <h1 id="missing-title" tabindex="-1">${account ? "This account could not be found" : "This link could not be opened"}</h1>
      <p>${account
        ? "The account may have moved or may no longer be public. Search the collection by name, or look in the original OHP archive."
        : "This address does not match a place or view in the current map. You can search the collection or return to the start."}</p>
      <div class="cta-row"><button class="btn btn-primary" data-act="explore">Search the collection ${icon("search")}</button>
        <button class="btn btn-ghost" data-act="home">Back to the start</button></div>
      <a class="archive-link" href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">Visit the original OHP archive ${icon("external-link")}</a>
    </section>
  </div>`;
}

// ---- helpers ----------------------------------------------------------------
function shortName(j) {
  const p = j.name.split(" ");
  return p.length > 1 ? `${p[0]} ${j.surname[0]}.` : j.name;
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
  const places = `${journey.waypoints.length} matched ${journey.waypoints.length === 1 ? "place" : "places"}`;
  return (journey.born ? `Born ${journey.born}. ${places}.` : `${places}.`) +
    (journey.captionedVideoCount ? " Captions listed." : "");
}
function recordingMeta(journey) {
  if (!journey.videoCount) return "";
  let captionText;
  if (journey.transcriptStatus === "pending") {
    captionText = "Caption availability is being checked.";
  } else if (journey.transcriptStatus === "unavailable") {
    captionText = "Vimeo did not make caption information available for these chapters.";
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
    <img class="war-brief-map" src="${siteResource(`assets/history/atlas-${eraMap}.svg`)}" alt="" aria-hidden="true">
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
function testimonyMoment(activeEvent, events, state, store) {
  if (!events.length) {
    return `<div class="testimony-moment is-empty">
      <strong>No dated place references</strong>
      <p>No place linked to a person's account has a date precise enough to place it in this year.</p>
    </div>`;
  }
  const places = `<details class="year-place-list" data-history-place-list${state.historyPlacesOpen ? " open" : ""}>
    <summary>Browse all ${events.length} recorded ${events.length === 1 ? "place" : "places"} ${icon("chevron")}</summary>
    <ul>${events.map((event) => `<li><button data-event="${esc(event.key)}" aria-pressed="${event.key === activeEvent?.key}">
      <span>${esc(event.place)}<small>${esc(event.role)}. ${event.count} ${event.count === 1 ? "account" : "accounts"} with a reference in ${event.year}</small></span>${icon("arrow-right")}
    </button></li>`).join("")}</ul>
  </details>`;
  if (!activeEvent) {
    return `<div class="testimony-moment">
      <p>Choose a place to find the accounts that name it in ${state.scrubYear}. The list includes places that do not fit on the map.</p>
      ${places}
    </div>`;
  }
  const personLink = (person) => {
    const journey = store.byId.get(person.id);
    return `<button class="event-person" data-survivor="${esc(person.id)}">
      <span class="event-avatar" aria-hidden="true">${profileMedal(journey, GROUP_COLOR[journey.group] || C.accent)}</span>
      <span class="event-person-name">${esc(person.name)}</span>${icon("arrow-right")}</button>`;
  };
  const names = activeEvent.people.slice(0, 4).map((person) => `<li>${personLink(person)}</li>`).join("");
  return `<div class="testimony-moment is-selected">
    <div class="moment-head">
      <button class="country-back" data-act="clear-event">${icon("arrow-right")} All places</button>
      <span class="moment-nav">
        <button data-act="prev-event" aria-label="Previous testimony place">${icon("arrow-right")}</button>
        <b>${events.indexOf(activeEvent) + 1} / ${events.length}</b>
        <button data-act="next-event" aria-label="Next testimony place">${icon("arrow-right")}</button>
      </span>
    </div>
    <strong id="testimony-place-title" tabindex="-1">${esc(activeEvent.place)}</strong>
    <span class="event-role">${esc(activeEvent.role)}</span>
    <ul class="event-people">${names}</ul>
    ${activeEvent.people.length > 4 ? `<details class="more-event-people"><summary>Show all ${activeEvent.people.length} people ${icon("chevron")}</summary>
      <div>${activeEvent.people.slice(4).map(personLink).join("")}</div></details>` : ""}
    <small>${activeEvent.count} ${activeEvent.count === 1 ? "account" : "accounts"}${activeEvent.approximate ? ", some dates are approximate" : ""}</small>
    <p class="event-route-note">Connections use only city and site references dated to ${state.scrubYear}. Open an account to follow its other recorded places.</p>
    ${places}
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
