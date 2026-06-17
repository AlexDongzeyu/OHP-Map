// ui.js — renders the overlay panels (landing, guided, explore, patterns, about) as
// class-based markup over the persistent atlas. Each render returns HTML; handlers are
// wired by the caller (app.js). Keeping markup here and styling in css/style.css keeps
// the map engine (atlas.js) and orchestration (app.js) clean.
import { C, ROLE_LABEL, esc, slug } from "./config.js";

const roman = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

function wpMeta(w) {
  const yr = w.year ? (w.approx ? `c. ${w.year}` : `${w.year}`) : "date uncertain";
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? ` · remembered as “${esc(w.asWritten)}”` : "";
  return `${w.role} · ${yr}${written}`;
}

// ---- LANDING ----------------------------------------------------------------
export function landing(store) {
  const m = store.meta;
  return `
  <div class="ov ov-landing">
    <div class="landing-card">
      <p class="kicker">A memorial map · Holocaust testimonies</p>
      <h1 class="display">Survivor<br>Journeys</h1>
      <p class="lede">Following the journeys of Holocaust survivors who shared their stories
        with Crestwood students — from their hometowns, through the ghettos and camps, to
        new lives in Toronto.</p>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Follow one journey <span aria-hidden="true">→</span></button>
        <button class="btn btn-ghost" data-act="explore">Explore the map</button>
      </div>
      <p class="scale">
        <b>${store.journeys.length}</b> survivors <span class="sep">·</span>
        <b>${store.journeys.length}</b> journeys <span class="sep">·</span>
        <b>${store.placeCount}</b> places remembered
      </p>
      <p class="care">Each path is drawn from a recorded testimony. Where memory is
        uncertain, we leave it uncertain. <button class="link" data-act="about">Read about our method.</button></p>
    </div>
  </div>`;
}

// ---- GUIDED -----------------------------------------------------------------
export function guided(store, state) {
  const j = store.byId.get(state.guidedId) || store.journeys[0];
  const first = j.name.split(" ")[0];
  const chips = (store.featured.length ? store.featured : store.journeys.slice(0, 8))
    .map((s) => `<button class="chip ${s.id === j.id ? "on" : ""}" data-guided="${esc(s.id)}">${esc(s.name.split(" ")[0])}</button>`)
    .join("");
  const chapters = j.waypoints.map((w, i) => `
    <section class="chapter" data-chapter="${i}">
      <div class="ch-head">
        <span class="ch-num">${roman[i] || i + 1}</span>
        <span class="ch-rule"></span>
        <span class="ch-role">${esc(w.role)}</span>
      </div>
      <h3 class="ch-title">${esc(w.canonical)}</h3>
      <div class="ch-sub">${esc(metaLine(w))}</div>
      ${w.quote ? `<blockquote>“${esc(trimQuote(w.quote))}”</blockquote>` : ""}
    </section>`).join("");
  return `
  <div class="ov ov-guided">
    <div class="narr scroll" data-narr>
      <div class="narr-head">
        <p class="kicker">A guided journey</p>
        <h2 class="serif-xl">${esc(j.name)}</h2>
        <p class="narr-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</p>
        ${statusTag(j)}
        <p class="bio">${esc(j.bio)}</p>
        <div class="follow-another">
          <div class="micro-label">Follow another life</div>
          <div class="chips">${chips}</div>
        </div>
      </div>
      ${chapters}
      <section class="chapter closing">
        <h3 class="serif-lg">A life, continued.</h3>
        <p class="bio">This route is only the shape of a life, not the whole of it.
          Read ${esc(first)}’s full testimony in the archive.</p>
        <a class="archive-link" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">
          Read ${esc(first)}’s full archive entry <span aria-hidden="true">↗</span></a>
      </section>
    </div>
  </div>`;
}

// ---- EXPLORE ----------------------------------------------------------------
export function explore(store, state) {
  const theme = state.theme;
  const chips = store.themes.slice(0, 8).map((t) =>
    `<button class="chip ${theme === t ? "on" : ""}" data-theme="${esc(t)}">${esc(t)}</button>`).join("");
  const shown = store.journeys.filter((j) => !theme || j.themes.includes(theme));
  const list = [...store.journeys]
    .sort((a, b) => (b.featured - a.featured) || a.name.localeCompare(b.name))
    .map((j) => {
      const match = !theme || j.themes.includes(theme);
      const isSel = j.id === state.selectedId;
      return `<button class="rail-card ${isSel ? "sel" : ""}" data-survivor="${esc(j.id)}" style="opacity:${match ? 1 : 0.4}">
        <span class="medal ${isSel ? "on" : ""}">${esc(j.initials)}</span>
        <span class="rail-text">
          <span class="rail-name">${j.featured ? "★ " : ""}${esc(j.name)}</span>
          <span class="rail-sub">${j.born ? "Born " + j.born + " · " : ""}${j.waypoints.length} places</span>
        </span></button>`;
    }).join("");

  return `
  <div class="ov ov-explore ${state.selectedId ? "has-sel" : ""}">
    <div class="filterbar">
      <span class="micro-label">Filter</span>
      ${chips}
      ${theme ? `<button class="chip clear" data-theme="">clear ×</button>` : ""}
    </div>
    <aside class="rail scroll">
      <div class="micro-label">${theme ? `${shown.length} of ${store.journeys.length} survivors` : `${store.journeys.length} survivors`}</div>
      <div class="rail-list">${list}</div>
    </aside>
    <div class="panel-host" data-panel>${state.selectedId ? panel(store, state) : ""}</div>
    ${!state.selectedId ? `<p class="explore-hint">Select a name, or click any point on the map, to follow that life.</p>` : ""}
  </div>`;
}

function panel(store, state) {
  const j = store.byId.get(state.selectedId);
  if (!j) return "";
  const steps = j.waypoints.map((w, i) => `
    <li>
      <span class="step-rail">
        <span class="step-dot ${w.overseas || w.newLife ? "ink" : ""}"></span>
        ${i < j.waypoints.length - 1 ? '<span class="step-line"></span>' : ""}
      </span>
      <span class="step-text">
        <span class="step-place">${esc(w.canonical)}</span>
        <span class="step-meta">${esc(wpMeta(w))}</span>
      </span>
    </li>`).join("");
  const tags = j.themes.map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const ver = j.reviewStatus === "reviewed"
    ? { c: C.verified, t: "Reviewed against the testimony" }
    : { c: C.accentSoft, t: "Auto-extracted — pending verification" };
  return `
    <aside class="panel scroll">
      <button class="panel-close" data-act="clear" aria-label="Close">×</button>
      <span class="medal medal-lg on">${esc(j.initials)}</span>
      <h2 class="serif-lg">${esc(j.name)}</h2>
      <div class="panel-meta">${j.born ? "Born " + j.born + " · " : ""}${esc(j.hometown)}</div>
      <p class="bio">${esc(j.bio)}</p>
      <svg class="mini" viewBox="0 0 340 150" data-mini></svg>
      <div class="mini-cap">Their route — hometown to new life.</div>
      <div class="micro-label">The journey</div>
      <ol class="journey">${steps}</ol>
      <div class="tags">${tags}</div>
      <div class="ver" style="color:${ver.c}"><span class="ver-dot" style="background:${ver.c}"></span>${ver.t}</div>
      <a class="archive-pill" href="${esc(j.archiveUrl)}" target="_blank" rel="noopener">Open full archive entry <span aria-hidden="true">↗</span></a>
    </aside>`;
}

// ---- PATTERNS ---------------------------------------------------------------
export function patterns(store, state) {
  const top = store.shared[0];
  const verified = store.connections.filter((c) => c.verified).length;
  const crossLine = top
    ? `${top.count} of these survivors describe being at <span class="accent">${esc(top.canonical.split(" (")[0])}</span>. The ringed places mark where separate lives passed through the same ground.`
    : `The ringed places mark where separate lives passed through the same ground.`;
  return `
  <div class="ov ov-patterns">
    <div class="patterns-intro">
      <p class="kicker">Patterns</p>
      <h2 class="serif-xl">What no single story shows</h2>
      <p class="lede sm">Every journey at once. Move the years to watch each life travel its
        route. Where dates are uncertain, the point softens to a glow.</p>
      <div class="legend">
        <span><span class="lg-line"></span>journey</span>
        <span><span class="lg-ring"></span>shared place</span>
      </div>
    </div>
    <div class="cross-note">
      <div class="cross-title">Threads that cross</div>
      <p>${crossLine}</p>
      <p class="cross-sub">${verified ? verified + " verified · " : ""}${store.connections.length} candidate overlaps — shown only where two records place people together in time, never as a claim they met.</p>
    </div>
    <div class="scrubber">
      <div class="scrub-head">
        <span class="micro-label">Year</span>
        <span class="scrub-year" data-year>${state.scrubYear}</span>
      </div>
      <input class="range" type="range" min="${store.time.min}" max="${store.time.max}" step="1" value="${state.scrubYear}" data-scrub aria-label="Year, ${store.time.min} to ${store.time.max}">
      <div class="scrub-ticks"><span>${store.time.min}</span><span>1939</span><span>1945</span><span>${store.time.max}</span></div>
    </div>
  </div>`;
}

// ---- ABOUT ------------------------------------------------------------------
export function about(store) {
  return `
  <div class="ov ov-about scroll">
    <div class="about-wrap">
      <p class="kicker">About this project</p>
      <h1 class="display sm">A map made of remembering.</h1>
      <p class="lede">For years, students at Crestwood Preparatory College have sat with
        Holocaust survivors and recorded their testimonies. This map traces those lives
        across geography — so a stranger can follow one person from a childhood street to a
        new beginning in Toronto.</p>
      <div class="about-grid">
        <div><h2>How the journeys were drawn</h2><p>Each path is built from places named in a
          survivor's public archive entry — matched to a curated gazetteer of historical
          names (so “Lemberg” resolves to today's Lviv), located once at build time, and
          ordered in time. The map is never the whole of a life; it is the route a life took.</p></div>
        <div><h2>How we handle uncertainty</h2><p>Memory does not keep exact dates, and we do
          not pretend otherwise. Approximate moments soften to a glow over a range of years
          rather than a hard point. Nothing is presented as fact until a person confirms it —
          a confidently-wrong pin is worse than a missing one.</p></div>
        <div><h2>On the data shown here</h2><p>These ${store.journeys.length} journeys are
          <strong>auto-extracted from public summaries</strong> in the OHP archive and are
          <strong>pending human verification and permission</strong>. Every survivor links
          back to their full archive entry; “same place, same time” links are shown only as
          candidates, never as a claim that two people met.</p></div>
        <div><h2>Credits</h2><p>Testimonies: the Crestwood Oral History Project
          (<a href="https://ohp.crestwood.on.ca" target="_blank" rel="noopener">ohp.crestwood.on.ca</a>).
          Basemap geometry: Natural Earth via world-atlas. Built with restraint, in memory of
          those who told their stories so that others would know. Source:
          <a href="https://github.com/AlexDongzeyu/OHP-Map" target="_blank" rel="noopener">AlexDongzeyu/OHP-Map</a>.</p></div>
      </div>
      <div class="cta-row">
        <button class="btn btn-primary" data-act="follow">Follow one journey →</button>
        <button class="btn btn-ghost" data-act="home">Back to the start</button>
      </div>
    </div>
  </div>`;
}

// ---- helpers ----------------------------------------------------------------
function metaLine(w) {
  const yr = w.year ? (w.approx ? `around ${w.year}` : `${w.year}`) : "date uncertain";
  const written = w.asWritten && w.asWritten.toLowerCase() !== (w.canonical || "").toLowerCase()
    ? `  ·  remembered as “${esc(w.asWritten)}”` : "";
  return `${yr}${written}`;
}
function statusTag(j) {
  return j.reviewStatus === "reviewed"
    ? `<span class="status-tag ok">Reviewed</span>`
    : `<span class="status-tag">Pending verification</span>`;
}
function trimQuote(q) {
  const s = String(q).trim().replace(/\s+/g, " ");
  return s.length > 160 ? s.slice(0, 157).trim() + "…" : s;
}

export { slug };
