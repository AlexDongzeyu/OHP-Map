// ui.js — overlay panels (landing, guided, explore, patterns, about) as class-based
// markup over the persistent atlas. Markup here; styling in css; map engine in atlas.js;
// orchestration in app.js. Everyone is presented equally — grouped by the archive's own
// categories (doc 13 §4.2), no "featured" hierarchy (§4.3), each with a brief intro (§4.4).
import { C, GROUP_COLOR, SYSTEM_REDUCED_MOTION, esc } from "./config.js";

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
      <p class="kicker">Crestwood Oral History Project</p>
      <h1 class="display">Journeys</h1>
      <p class="landing-subtitle">An atlas of recorded lives</p>
      <p class="lede">Explore the places remembered by Holocaust survivors, veterans,
        and community members in interviews with Crestwood students.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Begin with one story ${icon("arrow-right")}</button>
        <button class="btn btn-ghost" data-act="explore">Browse the collection</button>
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
  if (!journey.portrait) return null;
  const rights = String(journey.portraitRights || "").toLowerCase();
  return /\b(cleared|licensed|public domain|permission granted)\b/.test(rights)
    ? journey.portrait
    : null;
}

function validatedPortrait(journey) {
  return journey.portraitFaces > 0 ? clearedPortrait(journey) : null;
}

// ---- GUIDED -----------------------------------------------------------------
export function guided(store, state) {
  const j = store.byId.get(state.guidedId) || store.journeys[0];
  const first = j.name.split(" ")[0];
  const wp = j.waypoints;
  const portrait = validatedPortrait(j);
  const activeIndex = Math.min(state.guidedIndex || 0, Math.max(0, wp.length - 1));
  const chapters = wp.map((w, i) => {
    const context = store.warForJourney(j, w.year);
    const showContext = context && !["birthplace", "resettlement"].includes(w.roleKey);
    return `
    <section class="chapter ${i === 0 ? "chapter-first" : ""} ${i === activeIndex ? "is-active" : ""}" data-chapter="${i}">
      <div class="ch-head"><span class="ch-num">${i + 1} / ${wp.length}</span>
        <span class="ch-role">${esc(w.role)}</span></div>
      <h3 class="ch-title">${esc(w.canonical)}</h3>
      <div class="ch-sub">${esc(metaLine(w))}</div>
      ${showContext ? `<div class="chapter-war"><i></i><span>War context</span>${esc(context.phase)}</div>` : ""}
      ${w.quote ? `<blockquote>“${esc(trimQuote(w.quote))}”</blockquote>` : ""}
    </section>`;
  }).join("");
  return `
  <div class="ov ov-guided">
    <div class="narr scroll" data-narr tabindex="0" aria-label="Read ${esc(j.name)}'s journey">
      <div class="narr-head">
        <p class="micro-label">A guided account</p>
        <div class="story-heading">
          ${portrait ? `<figure class="guided-portrait">
            <img src="${esc(portrait)}" alt="${esc(j.name)}" loading="eager" decoding="async">
          </figure>` : ""}
          <div>
            <h2 class="serif-xl">${esc(j.name)}</h2>
            <p class="kicker">${esc(j.group)}</p>
            <p class="narr-meta">${profileMeta(j)}</p>
          </div>
        </div>
        ${recordingMeta(j)}
        <p class="bio">${esc(j.bio)}</p>
        ${serviceContext(store, j)}
        <p class="reading-note">Scroll through the account to follow its places on the map.</p>
      </div>
      ${chapters}
      <section class="chapter closing">
        <h3 class="serif-lg">Continue in the archive</h3>
        <p class="bio">The map includes the places named in this profile. The OHP page has
          the full interview and supporting material.</p>
        <a class="archive-link" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">
          Open ${esc(first)}'s OHP page ${icon("external-link")}</a>
      </section>
    </div>
    <nav class="narr-nav" aria-label="Journey places">
      <div class="narr-position" aria-live="polite" aria-atomic="true">
        <span data-guided-count>Place ${wp.length ? activeIndex + 1 : 0} of ${wp.length}</span>
        <strong data-guided-place>${esc(wp[activeIndex]?.canonical || "No recorded places")}</strong>
      </div>
      <button data-act="prev-chapter" aria-label="Previous place"${activeIndex === 0 ? " disabled" : ""}>${icon("arrow-right")}</button>
      <button data-act="next-chapter" aria-label="Next place"${activeIndex >= wp.length - 1 ? " disabled" : ""}>${icon("arrow-right")}</button>
    </nav>
  </div>`;
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
  const steps = wp.map((w, i) => `
    <li><span class="step-rail"><span class="step-dot ${w.newLife ? "ink" : ""}" style="--gc:${col}"></span>
      ${i < wp.length - 1 ? '<span class="step-line"></span>' : ""}</span>
      <span class="step-text"><span class="step-place">${esc(w.canonical)}</span>
        <span class="step-meta">${esc(wpMeta(w))}</span></span></li>`).join("");
  const tags = (j.conflicts.concat(j.themes)).slice(0, 5).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const reviewed = j.reviewStatus === "reviewed";
  return `
    <aside class="panel scroll" aria-labelledby="profile-name">
      <div class="panel-topline"><span class="micro-label">From the collection</span>
        <button class="panel-close" data-act="clear" aria-label="Close profile">${icon("close")}</button></div>
      <div class="profile-heading">
        ${profileMedal(j, col, true)}
        <div>
          <div class="panel-group" style="--gc:${col}">${esc(j.group)}</div>
          <h2 class="serif-lg" id="profile-name" tabindex="-1">${esc(j.name)}</h2>
          <div class="panel-meta">${profileMeta(j)}</div>
        </div>
      </div>
      <div class="profile-actions">
        ${wp.length > 1 ? `<button class="guided-pill" data-guided="${esc(j.id)}">Follow this account ${icon("arrow-right")}</button>` : ""}
        <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Original interview ${icon("external-link")}</a>
      </div>
      ${recordingMeta(j)}
      <p class="bio">${esc(j.bio)}</p>
      ${serviceContext(store, j)}
      ${wp.length > 1 ? `<svg class="mini" viewBox="0 0 340 150" data-mini></svg>
      <div class="mini-cap">Places named in the OHP profile.</div>` : ""}
      <div class="micro-label">Recorded places</div>
      <ol class="journey">${steps}</ol>
      <div class="tags">${tags}</div>
      ${reviewed ? `<div class="ver" style="color:${C.verified}"><span class="ver-dot"></span>Checked against the interview</div>` : ""}
    </aside>`;
}

function mapTools() {
  return `<div class="map-tools" role="group" aria-label="Map controls">
    <button data-act="zoom-in" aria-label="Zoom in" title="Zoom in">${icon("plus")}</button>
    <button data-act="zoom-out" aria-label="Zoom out" title="Zoom out">${icon("minus")}</button>
    <button data-act="reset-map" aria-label="Fit map to view" title="Fit map to view">${icon("fit")}</button>
  </div>`;
}

function profileMedal(journey, color, large = false) {
  const portrait = clearedPortrait(journey);
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
      <button class="seg ${layer === "origins" ? "on" : ""}" aria-pressed="${layer === "origins"}" data-layer="origins">Birthplaces</button>
    </div>`;

  if (layer === "origins") {
    const list = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
      .map(([c, n]) => `<li><span class="oc-name">${esc(c)}</span><span class="oc-bar"><span style="width:${Math.round(n / topOrigin[1] * 100)}%"></span></span><span class="oc-n">${n}</span></li>`).join("");
    return `
    <div class="ov ov-patterns is-origins">
      <div class="patterns-intro">
        <p class="kicker">Archive birthplaces</p>
        <h2 class="serif-xl">Where the accounts begin</h2>
        <p class="lede sm">${topOrigin
          ? `<span class="accent">${esc(topOrigin[0])}</span> has the largest count, with <b>${topOrigin[1]}</b> recorded birthplaces.`
          : "No birthplace data is available."}</p>
        ${toggle}
        <ul class="origin-list">${list}</ul>
        <p class="cross-sub">Historical place names are grouped under present-day countries.</p>
      </div>
      ${mapTools()}
    </div>`;
  }

  return `
  <div class="ov ov-patterns">
    <div class="patterns-map-head">
      <div>
        <p class="micro-label">Historical atlas / 1914 to 2026</p>
        <h2>Territory and testimony</h2>
      </div>
      ${toggle}
    </div>
    <aside class="history-dossier" data-pattern-events tabindex="0" aria-label="Historical context and recorded places">${patternsEvents(store, state)}</aside>
    <div class="scrubber">
      <div class="scrub-head"><span class="micro-label">Historical timeline</span>
        <span class="scrub-year" data-year>${state.scrubYear}</span></div>
      <input class="range" type="range" min="${store.time.min}" max="${store.time.max}" step="1" value="${state.scrubYear}" data-scrub aria-label="Year, ${store.time.min} to ${store.time.max}">
      ${boundaryDensity(store, state.scrubYear)}
      <div class="scrub-ticks"><span>${store.time.min}</span><span>1945</span><span>1989</span><span>${store.time.max}</span></div>
    </div>
    ${mapTools()}
  </div>`;
}

export function patternsEvents(store, state) {
  const events = store.eventsByYear.get(state.scrubYear) || [];
  const activeEvent = events.find((event) => event.key === state.patternEventKey) || null;
  const previousDisabled = state.scrubYear <= store.time.min ? " disabled" : "";
  const nextDisabled = state.scrubYear >= store.time.max ? " disabled" : "";
  return `
    ${warBrief(store, state.scrubYear, previousDisabled, nextDisabled)}
    ${testimonyMoment(activeEvent, events)}`;
}

// ---- ABOUT ------------------------------------------------------------------
export function about(store) {
  const collection = store.groups.map((g) => `<div><dt>${esc(g.name)}</dt><dd>${g.count.toLocaleString("en-CA")}</dd></div>`).join("");
  return `
  <div class="ov ov-about scroll">
    <div class="about-wrap">
      <header class="about-header">
        <p class="kicker">Crestwood Oral History Project</p>
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
        <section><h2>Reading a recorded life</h2><p>Guided follows one person's places in sequence.
          Explore lets you search the collection. Patterns puts dated accounts alongside
          changing territories from 1914 to 2026.</p></section>
        <section><h2>From testimony to map</h2><p>Each route uses places named on a public OHP
          page. Historical names are matched to current locations, so &quot;Lemberg&quot;
          resolves to Lviv. Dates determine the order when the source provides them.</p>
          <p>Routes connect recorded places; they do not reconstruct the exact roads a person
          travelled. Approximate dates remain labelled as approximate.</p></section>
        <section><h2>Read alongside the original</h2><p>Profiles are built from public OHP
          summaries. Automated place matching has not been checked for every profile.
          Each account links to its original interview so you can read and listen in context.</p></section>
        <section class="about-sources"><h2>Sources and credits</h2>
          <dl>
            <div><dt>Interviews and photographs</dt><dd><a href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">Crestwood Oral History Project</a></dd></div>
            <div><dt>Historical territories</dt><dd>OpenHistoricalMap (CC0)</dd></div>
            <div><dt>War participants</dt><dd>Correlates of War, Inter-State War Data v4.0</dd></div>
            <div><dt>Basemap</dt><dd>Natural Earth via world-atlas</dd></div>
            <div><dt>Website code</dt><dd><a href="https://github.com/AlexDongzeyu/OHP-Map" target="_blank" rel="noopener">AlexDongzeyu/OHP-Map</a></dd></div>
          </dl>
        </section>
        </div>
      </div>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Begin with one story ${icon("arrow-right")}</button>
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
  const yr = w.year ? (w.approx ? `c. ${w.year}` : `${w.year}`) : "date uncertain";
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? `. Listed as “${esc(w.asWritten)}”` : "";
  return `${w.role}, ${yr}${written}`;
}
function metaLine(w) {
  const yr = w.year ? (w.approx ? `around ${w.year}` : `${w.year}`) : "date uncertain";
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? `. Listed as “${esc(w.asWritten)}”` : "";
  return `${yr}${written}`;
}
function profileMeta(journey) {
  if (journey.born && journey.hometown) return `Born ${journey.born} in ${esc(journey.hometown)}`;
  if (journey.born) return `Born ${journey.born}`;
  return esc(journey.hometown);
}
function serviceContext(store, journey) {
  const context = store.warForJourney(journey);
  if (!context) return "";
  return `<div class="service-context">
    <span class="micro-label">War context</span>
    <strong>${esc(journey.serviceConflict)}</strong>
    <span>${esc(context.coalition_label)} <b>against</b> ${esc(context.opposition_label)}</span>
  </div>`;
}
function recordingMeta(journey) {
  if (!journey.videoCount) return "";
  let captionText;
  if (journey.transcriptStatus === "pending") {
    captionText = "caption status pending";
  } else if (journey.transcriptStatus === "unavailable") {
    captionText = "caption status unavailable";
  } else if (journey.captionedVideoCount) {
    captionText = `${journey.captionedVideoCount} with public captions`;
  } else {
    captionText = "no public captions";
  }
  return `<p class="recording-meta">
    <span>${journey.videoCount} interview ${journey.videoCount === 1 ? "chapter" : "chapters"}</span>
    <span>${captionText}</span>
  </p>`;
}
function warBrief(store, year, previousDisabled, nextDisabled) {
  const context = store.warAt(year);
  if (!context) return "";
  const boundary = store.historicalIndex.years.find((entry) => entry.year === year);
  const eraMap = year <= 1918 ? 1914 : (
    year <= 1945 ? 1944 : (year <= 1988 ? 1960 : (year <= 2000 ? 1991 : 2026))
  );
  const corridors = context.archive_conflict
    ? (store.veteranCorridors.get(context.archive_conflict) || [])
      .filter((corridor) => corridor.count > 1)
      .slice(0, 8)
    : [];
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
      <div class="war-brief-top">
        <span class="micro-label">${esc(context.conflict)}</span>
        <span class="war-stepper">
          <button class="event-step prev" data-act="prev-year" aria-label="Previous year"${previousDisabled}>
            ${icon("arrow-right")}
          </button>
          <b data-year>${year}</b>
          <button class="event-step" data-act="next-year" aria-label="Next year"${nextDisabled}>
            ${icon("arrow-right")}
          </button>
        </span>
      </div>
      <strong>${esc(context.phase)}</strong>
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
      <p>No testimony place has a date in this year.</p>
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
  const names = activeEvent.people.slice(0, 4).map((person) => person.name).join(", ");
  const more = activeEvent.people.length > 4 ? ` +${activeEvent.people.length - 4}` : "";
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
      <span class="event-names">${esc(names)}${more}</span>
    </span>
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
function trimQuote(q) {
  return String(q).trim().replace(/\s+/g, " ");
}
