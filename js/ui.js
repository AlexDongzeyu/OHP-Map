// ui.js — overlay panels (landing, guided, explore, patterns, about) as class-based
// markup over the persistent atlas. Markup here; styling in css; map engine in atlas.js;
// orchestration in app.js. Everyone is presented equally — grouped by the archive's own
// categories (doc 13 §4.2), no "featured" hierarchy (§4.3), each with a brief intro (§4.4).
import { C, GROUP_COLOR, esc } from "./config.js";

const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
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
      <p class="kicker">Crestwood Oral History Project</p>
      <p class="lede">For years, Crestwood students have interviewed Holocaust survivors
        and war veterans. This map follows their journeys — from where their lives began,
        through the places history carried them, to the homes they built afterward.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Begin with one story ${icon("arrow-right")}</button>
        <button class="btn btn-ghost" data-act="explore">Explore the map</button>
      </div>
      <p class="scale">
        <span class="metric"><b>${store.journeys.length}</b> <span>people</span></span>
        <span class="metric"><b>${store.placeCount}</b> <span>places</span></span>
        <span class="metric"><b>${groups}</b> <span>communities</span></span>
        <span class="metric"><b>${conflicts}</b> <span>eras</span></span>
      </p>
      <p class="care">A school project, collected by students. Each path is drawn from a
        recorded testimony; where memory is uncertain, we leave it uncertain.
        <button class="link" data-act="about">About this project.</button></p>
    </div>
    <div class="legend-mini">
      <span><span class="lm-dot"></span> a person</span>
      <span><span class="lm-line"></span> a journey</span>
      <span><span class="lm-shade"></span> where more came from</span>
    </div>
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

// ---- GUIDED -----------------------------------------------------------------
export function guided(store, state) {
  const j = store.byId.get(state.guidedId) || store.journeys[0];
  const first = j.name.split(" ")[0];
  const wp = j.waypoints;
  const chapters = wp.map((w, i) => {
    const context = store.warForJourney(j, w.year);
    const showContext = context && !["birthplace", "resettlement"].includes(w.roleKey);
    return `
    <section class="chapter" data-chapter="${i}">
      <div class="ch-head"><span class="ch-num">${roman[i] || i + 1}</span>
        <span class="ch-role">${esc(w.role)}</span></div>
      <h3 class="ch-title">${esc(w.canonical)}</h3>
      <div class="ch-sub">${esc(metaLine(w))}</div>
      ${showContext ? `<div class="chapter-war"><i></i><span>War context</span>${esc(context.phase)}</div>` : ""}
      ${w.quote ? `<blockquote>“${esc(trimQuote(w.quote))}”</blockquote>` : ""}
    </section>`;
  }).join("");
  return `
  <div class="ov ov-guided">
    <div class="narr scroll" data-narr>
      <div class="narr-head">
        <h2 class="serif-xl">${esc(j.name)}</h2>
        <p class="kicker">${esc(j.group)} · a guided journey</p>
        <p class="narr-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</p>
        ${serviceContext(store, j)}
        <p class="bio">${esc(j.bio)}</p>
      </div>
      ${chapters}
      <section class="chapter closing">
        <h3 class="serif-lg">A life, continued.</h3>
        <p class="bio">This route is only the shape of a life, not the whole of it.</p>
        <a class="archive-link" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">
          Read ${esc(first)}’s full archive entry ${icon("external-link")}</a>
      </section>
    </div>
  </div>`;
}

// ---- EXPLORE ----------------------------------------------------------------
export function explore(store, state) {
  const groupChips = store.groups.map((g) => {
    const on = state.groupFilter.has(g.name);
    const col = GROUP_COLOR[g.name] || C.accent;
    return `<button class="gchip ${on ? "on" : ""}" data-group="${esc(g.name)}" style="--gc:${col}">
      <span class="gdot"></span>${esc(g.name)} <span class="gn">${g.count}</span></button>`;
  }).join("");

  const { html, shown, total } = railInner(store, state);
  return `
  <div class="ov ov-explore ${state.selectedId ? "has-sel" : ""}">
    <aside class="rail scroll">
      <div class="rail-search">
        ${icon("search")}
        <input id="search" class="search-input" type="search" placeholder="Search a name, place, or keyword…"
          value="${esc(state.query || "")}" autocomplete="off" aria-label="Search people">
      </div>
      <p class="rail-lead micro-label">Browse by community — everyone is here, grouped as the archive groups them.</p>
      <div class="gchips">${groupChips}</div>
      <div class="rail-count micro-label" data-rail-count>${shown} of ${total} shown</div>
      <div class="rail-list" data-rail-list>${html}</div>
    </aside>
    <div class="panel-host" data-panel>${state.selectedId ? panel(store, state) : ""}</div>
    ${!state.selectedId ? `<p class="explore-hint">Click any point on the map, or a name, to follow that life.<br>Drag to pan · scroll to zoom.</p>` : ""}
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
  if (!html) html = `<p class="rail-empty">No one matches that search.</p>`;
  else if (matched.length > slice.length)
    html += `<button class="rail-more" data-act="more">Show more (${matched.length - slice.length} more)</button>`;
  return { html, shown: slice.length, total: matched.length };
}

function railCard(j, isSel) {
  const col = GROUP_COLOR[j.group] || C.accent;
  return `<button class="rail-card ${isSel ? "sel" : ""}" data-survivor="${esc(j.id)}">
    ${profileMedal(j, col)}
    <span class="rail-text">
      <span class="rail-name">${esc(j.name)}</span>
      <span class="rail-intro">${esc(j.intro || (j.born ? "Born " + j.born : j.group))}</span>
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
    <aside class="panel scroll">
      <button class="panel-close" data-act="clear" aria-label="Close">${icon("close")}</button>
      ${profileMedal(j, col, true)}
      <div class="panel-group" style="--gc:${col}">${esc(j.group)}</div>
      <h2 class="serif-lg">${esc(j.name)}</h2>
      <div class="panel-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</div>
      <p class="panel-intro">${esc(j.intro)}</p>
      ${serviceContext(store, j)}
      <p class="bio">${esc(j.bio)}</p>
      ${wp.length > 1 ? `<svg class="mini" viewBox="0 0 340 150" data-mini></svg>
      <div class="mini-cap">Their route, as named in the archive.</div>` : ""}
      <div class="micro-label">The journey</div>
      <ol class="journey">${steps}</ol>
      <div class="tags">${tags}</div>
      ${reviewed ? `<div class="ver" style="color:${C.verified}"><span class="ver-dot"></span>Reviewed against the testimony</div>` : ""}
      ${wp.length > 1 ? `<button class="guided-pill" data-guided="${esc(j.id)}">Follow this journey as a story ${icon("arrow-right")}</button>` : ""}
      <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Open full archive entry ${icon("external-link")}</a>
    </aside>`;
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
    <div class="layer-toggle" role="tablist" aria-label="Pattern layer">
      <button class="seg ${layer === "journeys" ? "on" : ""}" data-layer="journeys">History &amp; journeys</button>
      <button class="seg ${layer === "origins" ? "on" : ""}" data-layer="origins">Where people came from</button>
    </div>`;

  if (layer === "origins") {
    const list = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
      .map(([c, n]) => `<li><span class="oc-name">${esc(c)}</span><span class="oc-bar"><span style="width:${Math.round(n / topOrigin[1] * 100)}%"></span></span><span class="oc-n">${n}</span></li>`).join("");
    return `
    <div class="ov ov-patterns">
      <div class="patterns-intro">
        <h2 class="serif-xl">The darker the country, the more lives began there</h2>
        <p class="kicker">Density · where people came from</p>
        <p class="lede sm">A count of birthplaces across the whole archive.
          ${topOrigin ? `Most — <b>${topOrigin[1]}</b> — began in <span class="accent">${esc(topOrigin[0])}</span>.` : ""}</p>
        ${toggle}
        <ul class="origin-list">${list}</ul>
        <p class="cross-sub">Counts are by birthplace, mapped to present-day countries.</p>
      </div>
    </div>`;
  }

  return `
  <div class="ov ov-patterns">
    <div class="patterns-map-head">
      <div>
        <p class="micro-label">Historical atlas · 1914–2026</p>
        <h2>Territory &amp; testimony</h2>
      </div>
      ${toggle}
    </div>
    <aside class="history-dossier" data-pattern-events>${patternsEvents(store, state)}</aside>
    <div class="scrubber">
      <div class="scrub-head"><span class="micro-label">Historical timeline</span>
        <span class="scrub-year" data-year>${state.scrubYear}</span></div>
      <input class="range" type="range" min="${store.time.min}" max="${store.time.max}" step="1" value="${state.scrubYear}" data-scrub aria-label="Year, ${store.time.min} to ${store.time.max}">
      ${boundaryDensity(store, state.scrubYear)}
      <div class="scrub-ticks"><span>${store.time.min}</span><span>1945</span><span>1989</span><span>${store.time.max}</span></div>
    </div>
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
  const groupLines = store.groups.map((g) => `${g.count} ${g.name.toLowerCase()}`).join(", ");
  return `
  <div class="ov ov-about scroll">
    <div class="about-wrap">
      <h1 class="display sm">A map made of remembering.</h1>
      <p class="kicker">About this project</p>
      <p class="lede">For years, students at Crestwood Preparatory College have sat with
        Holocaust survivors, war veterans, and community members and recorded their
        testimonies. This map traces those lives across geography — so a stranger can follow
        one person from a childhood street to the places history carried them, and home again.</p>
      <div class="about-grid">
        <div><h2>Who is here</h2><p>Everyone the archive holds, grouped as the archive groups
          them: ${esc(groupLines)}. Every person is shown the same way — no one is featured
          above anyone else.</p></div>
        <div><h2>How the journeys were drawn</h2><p>Each path is built from places named in a
          person's public archive entry — matched to a gazetteer of historical names (so
          “Lemberg” resolves to today's Lviv), located once at build time, and ordered in time.
          The map is never the whole of a life; it is the route a life took.</p></div>
        <div><h2>How we handle uncertainty</h2><p>Memory does not keep exact dates, and we do
          not pretend otherwise. Approximate moments soften to a glow over a range of years.
          Nothing is presented as fact until a person confirms it — a confidently-wrong pin is
          worse than a missing one.</p></div>
        <div><h2>On the data shown here</h2><p>These ${store.journeys.length} journeys are
          <strong>auto-extracted from public summaries</strong> and are <strong>pending human
          verification and permission</strong>. Every person links back to their full archive
          entry; “same place, same time” links are shown only as candidates.</p></div>
        <div><h2>Credits</h2><p>Testimonies: the Crestwood Oral History Project
          (<a href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">ohp.crestwood.on.ca</a>).
          Historical belligerents: Correlates of War Project, Inter-State War Data v4.0.
          Dated territory polygons: OpenHistoricalMap (CC0). Fallback basemap geometry:
          Natural Earth via world-atlas. Historical relations are community-mapped and retain
          their source dates and names. Built in memory of
          those who told their stories so that others would know. Source:
          <a href="https://github.com/AlexDongzeyu/OHP-Map" target="_blank" rel="noopener">AlexDongzeyu/OHP-Map</a>.</p></div>
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
    ? ` · “${esc(w.asWritten)}”` : "";
  return `${w.role} · ${yr}${written}`;
}
function metaLine(w) {
  const yr = w.year ? (w.approx ? `around ${w.year}` : `${w.year}`) : "date uncertain";
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? `  ·  remembered as “${esc(w.asWritten)}”` : "";
  return `${yr}${written}`;
}
function serviceContext(store, journey) {
  const context = store.warForJourney(journey);
  if (!context) return "";
  return `<div class="service-context">
    <span class="micro-label">Conflict shown behind this route</span>
    <strong>${esc(journey.serviceConflict)}</strong>
    <span>${esc(context.coalition_label)} <b>against</b> ${esc(context.opposition_label)}</span>
  </div>`;
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
      ${corridors.length ? `<span><i class="route"></i>${corridors.length} common service corridors</span>` : ""}
    </div>` : `
    <div class="war-legend" aria-label="Territorial map legend">
      <span><i class="territory"></i>Dated territory</span>
      <span><i class="route"></i>Testimony journey</span>
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
        <span>${boundary ? `${boundary.active} territories · ${boundary.changes} changes` : ""}</span>
        <span>OHM · CC0</span>
      </small>
    </div>
  </section>`;
}
function testimonyMoment(activeEvent, events) {
  if (!events.length) {
    return `<div class="testimony-moment is-empty">
      <span class="micro-label">Testimony layer</span>
      <p>No dated testimony moment is recorded for this year.</p>
    </div>`;
  }
  if (!activeEvent) {
    return `<div class="testimony-moment">
      <span class="micro-label">${events.length} recorded ${events.length === 1 ? "place" : "places"}</span>
      <p>Select a ring on the map to inspect one testimony moment.</p>
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
    <small>${activeEvent.count} ${activeEvent.count === 1 ? "testimony" : "testimonies"}${activeEvent.approximate ? " · includes approximate dates" : ""}</small>
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
  const s = String(q).trim().replace(/\s+/g, " ");
  return s.length > 160 ? s.slice(0, 157).trim() + "…" : s;
}
