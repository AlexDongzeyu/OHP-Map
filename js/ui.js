// ui.js — overlay panels (landing, guided, explore, patterns, about) as class-based
// markup over the persistent atlas. Markup here; styling in css; map engine in atlas.js;
// orchestration in app.js. Everyone is presented equally — grouped by the archive's own
// categories (doc 13 §4.2), no "featured" hierarchy (§4.3), each with a brief intro (§4.4).
import { C, GROUP_COLOR, esc } from "./config.js";

const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];
const RAIL_PAGE = 140;

// ---- LANDING ----------------------------------------------------------------
export function landing(store) {
  const groups = store.groups.length;
  const conflicts = store.conflicts.length;
  return `
  <div class="ov ov-landing">
    <div class="landing-card">
      <p class="kicker">Crestwood Oral History Project</p>
      <h1 class="display">Journeys</h1>
      <p class="lede">For years, Crestwood students have interviewed Holocaust survivors
        and war veterans. This map follows their journeys — from where their lives began,
        through the places history carried them, to the homes they built afterward.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Begin with one story <span aria-hidden="true">→</span></button>
        <button class="btn btn-ghost" data-act="explore">Explore the map</button>
      </div>
      <p class="scale">
        <b>${store.journeys.length}</b> people <span class="sep">·</span>
        <b>${store.placeCount}</b> places <span class="sep">·</span>
        <b>${groups}</b> communities <span class="sep">·</span>
        <b>${conflicts}</b> eras
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

// ---- GUIDED -----------------------------------------------------------------
export function guided(store, state) {
  const j = store.byId.get(state.guidedId) || store.journeys[0];
  const first = j.name.split(" ")[0];
  const others = store.journeys.filter((s) => s.id !== j.id && s.waypoints.length >= 3).slice(0, 6);
  const chips = [j, ...others].map((s) =>
    `<button class="chip ${s.id === j.id ? "on" : ""}" data-guided="${esc(s.id)}">${esc(shortName(s))}</button>`).join("");
  const wp = j.waypoints;
  const chapters = wp.map((w, i) => `
    <section class="chapter" data-chapter="${i}">
      <div class="ch-head"><span class="ch-num">${roman[i] || i + 1}</span>
        <span class="ch-rule"></span><span class="ch-role">${esc(w.role)}</span></div>
      <h3 class="ch-title">${esc(w.canonical)}</h3>
      <div class="ch-sub">${esc(metaLine(w))}</div>
      ${w.quote ? `<blockquote>“${esc(trimQuote(w.quote))}”</blockquote>` : ""}
    </section>`).join("");
  return `
  <div class="ov ov-guided">
    <div class="narr scroll" data-narr>
      <div class="narr-head">
        <p class="kicker">${esc(j.group)} · a guided journey</p>
        <h2 class="serif-xl">${esc(j.name)}</h2>
        <p class="narr-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</p>
        <p class="bio">${esc(j.bio)}</p>
        <div class="follow-another"><div class="micro-label">Follow another life</div>
          <div class="chips">${chips}</div></div>
      </div>
      ${chapters}
      <section class="chapter closing">
        <h3 class="serif-lg">A life, continued.</h3>
        <p class="bio">This route is only the shape of a life, not the whole of it.</p>
        <a class="archive-link" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">
          Read ${esc(first)}’s full archive entry <span aria-hidden="true">↗</span></a>
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
    <span class="medal" style="--gc:${col}">${esc(j.initials)}</span>
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
  const ver = j.reviewStatus === "reviewed"
    ? { c: C.verified, t: "Reviewed against the testimony" }
    : { c: C.accentSoft, t: "Auto-extracted — pending verification" };
  return `
    <aside class="panel scroll">
      <button class="panel-close" data-act="clear" aria-label="Close">×</button>
      <span class="medal medal-lg" style="--gc:${col}">${esc(j.initials)}</span>
      <div class="panel-group" style="--gc:${col}">${esc(j.group)}</div>
      <h2 class="serif-lg">${esc(j.name)}</h2>
      <div class="panel-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</div>
      <p class="panel-intro">${esc(j.intro)}</p>
      <p class="bio">${esc(j.bio)}</p>
      ${wp.length > 1 ? `<svg class="mini" viewBox="0 0 340 150" data-mini></svg>
      <div class="mini-cap">Their route, as named in the archive.</div>` : ""}
      <div class="micro-label">The journey</div>
      <ol class="journey">${steps}</ol>
      <div class="tags">${tags}</div>
      <div class="ver" style="color:${ver.c}"><span class="ver-dot" style="background:${ver.c}"></span>${ver.t}</div>
      ${wp.length > 1 ? `<button class="guided-pill" data-guided="${esc(j.id)}">Follow this journey as a story →</button>` : ""}
      <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Open full archive entry <span aria-hidden="true">↗</span></a>
    </aside>`;
}

// ---- PATTERNS ---------------------------------------------------------------
export function patterns(store, state) {
  const layer = state.patternsLayer || "journeys";
  const top = store.shared[0];
  const topOrigin = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1])[0];
  const toggle = `
    <div class="layer-toggle" role="tablist" aria-label="Pattern layer">
      <button class="seg ${layer === "journeys" ? "on" : ""}" data-layer="journeys">Journeys &amp; years</button>
      <button class="seg ${layer === "origins" ? "on" : ""}" data-layer="origins">Where people came from</button>
    </div>`;

  if (layer === "origins") {
    const list = [...store.originCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 9)
      .map(([c, n]) => `<li><span class="oc-name">${esc(c)}</span><span class="oc-bar"><span style="width:${Math.round(n / topOrigin[1] * 100)}%"></span></span><span class="oc-n">${n}</span></li>`).join("");
    return `
    <div class="ov ov-patterns">
      <div class="patterns-intro">
        <p class="kicker">Density · where people came from</p>
        <h2 class="serif-xl">The darker the country, the more lives began there</h2>
        <p class="lede sm">A count of birthplaces across the whole archive.
          ${topOrigin ? `Most — <b>${topOrigin[1]}</b> — began in <span class="accent">${esc(topOrigin[0])}</span>.` : ""}</p>
        ${toggle}
        <ul class="origin-list">${list}</ul>
        <p class="cross-sub">Counts are by birthplace, mapped to present-day countries.</p>
      </div>
    </div>`;
  }

  const crossLine = top
    ? `${top.count} people describe being at <span class="accent">${esc(top.canonical.split(" (")[0])}</span>. The ringed places mark where separate lives passed through the same ground.`
    : `The ringed places mark where separate lives passed through the same ground.`;
  return `
  <div class="ov ov-patterns">
    <div class="patterns-intro">
      <p class="kicker">Patterns · every journey at once</p>
      <h2 class="serif-xl">What no single story shows</h2>
      <p class="lede sm">Move the years to watch each life travel its route. Where dates are
        uncertain, the point softens to a glow.</p>
      ${toggle}
      <div class="legend">
        <span><span class="lg-line"></span>journey</span>
        <span><span class="lg-ring"></span>shared place</span>
      </div>
    </div>
    <div class="cross-note">
      <div class="cross-title">Threads that cross</div>
      <p>${crossLine}</p>
      <p class="cross-sub">${store.connections.length} candidate overlaps — shown only where two records place people together in time, never as a claim they met.</p>
    </div>
    <div class="scrubber">
      <div class="scrub-head"><span class="micro-label">Year</span>
        <span class="scrub-year" data-year>${state.scrubYear}</span></div>
      <input class="range" type="range" min="${store.time.min}" max="${store.time.max}" step="1" value="${state.scrubYear}" data-scrub aria-label="Year, ${store.time.min} to ${store.time.max}">
      <div class="scrub-ticks"><span>${store.time.min}</span><span>1939</span><span>1945</span><span>${store.time.max}</span></div>
    </div>
  </div>`;
}

// ---- ABOUT ------------------------------------------------------------------
export function about(store) {
  const groupLines = store.groups.map((g) => `${g.count} ${g.name.toLowerCase()}`).join(", ");
  return `
  <div class="ov ov-about scroll">
    <div class="about-wrap">
      <p class="kicker">About this project</p>
      <h1 class="display sm">A map made of remembering.</h1>
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
          Basemap geometry: Natural Earth via world-atlas. Built with restraint, in memory of
          those who told their stories so that others would know. Source:
          <a href="https://github.com/AlexDongzeyu/OHP-Map" target="_blank" rel="noopener">AlexDongzeyu/OHP-Map</a>.</p></div>
      </div>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Begin with one story →</button>
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
function trimQuote(q) {
  const s = String(q).trim().replace(/\s+/g, " ");
  return s.length > 160 ? s.slice(0, 157).trim() + "…" : s;
}
