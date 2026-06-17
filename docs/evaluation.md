# Evaluation — Phase 2 (doc 12)

The site measured against the reference projects in doc 10 — Arolsen Archives
**TransRem** (the closest analog), the Mapbox/MapLibre storytelling pattern,
**ONSvisual/income-scrolly**, **The Pudding**, and NYT **"Snow Fall"** — across the six
axes doc 12 names. Each row records where the site stood *before* this iteration and the
action taken.

## (a) First-time clarity
- **Before:** dropped visitors into the Guided scroll; no purpose statement, no scale,
  no first action. A stranger bounced. This was the single biggest gap vs. TransRem,
  which opens by telling you what you're looking at and offers one-path vs. whole-network.
- **Action:** a dedicated **landing/hero** — kicker, serif title, one-sentence purpose,
  a live scale line ("221 survivors · 62 places · 1933–1950"), a **primary** action
  ("Follow one journey") and a **secondary** ("Explore the map"), plus an About link and
  a faint, data-drawn hero of the real journeys. Deep links skip the intro.

## (b) Visual craft
- **Before:** system fonts, two competing accents, uneven spacing — read as "student
  project," not "museum exhibit" (the Reuters/Pudding bar).
- **Action:** a real design system in `css/tokens.css` — **Spectral** (humanist serif
  for names/headings) + **Inter** (UI), both self-hosted; warm archival paper, near-black
  ink, **one** ember accent, everything else greyscale; an 8px spacing scale; a brand
  mark; a faint map vignette. Applied across every screen.

## (c) Motion & storytelling
- **Before:** SnakeAnim self-drawing line existed but the experience wasn't framed.
- **Action:** kept the **one restrained signature effect** (self-drawing journey lines)
  the references prescribe — *restraint beats spectacle*. The hero performs a single slow
  reveal, never loops. All motion honours `prefers-reduced-motion`. No fly-throughs, no
  3D camp reconstructions (doc 08 guardrails).

## (d) Information architecture
- **Before:** three lonely tab words as the only navigation; no About; no way back to an
  overview.
- **Action:** a labelled top bar with a clickable brand (returns to the intro), the three
  modes, and an **About** entry; an About/methodology modal; an honest "pending
  verification" banner with a "Why?" link into it. Two entry points are supported
  conceptually (full-page story vs. embeddable explore) and the embed snippet remains.

## (e) Accessibility
- **Before:** good bones (skip link, ARIA tabs) but the new surfaces needed care.
- **Action:** keyboard-operable intro buttons, modes, and modal (Esc + backdrop close);
  AA-contrast ember on paper; visible focus rings; the hero canvas is `aria-hidden` and
  `pointer-events:none`; reduced-motion fully honoured; the survivor list mirrors the map
  for non-mouse users.

## (f) Empty / loading / error states
- **Before:** none — the empty state *was* the site, which is much of why it read as
  broken.
- **Action:** a map loading state, a friendly data-error message (`#status`), and the
  intro itself acts as a graceful first-paint cover while data loads. No-results in
  Explore shows a count ("0 of 221 shown").

## Where it still trails the very top tier (honest)
- **Map engine:** Leaflet raster tiles, not MapLibre GL vector + deck.gl arcs. The
  current look is museum-quiet and accessible; a future MapLibre migration (doc 10 §E)
  would unlock smoother arcs and a globe establishing-shot. Deferred on purpose —
  fundamentals (data, clarity, type) first, per The Pudding's own lesson.
- **Verification:** all 221 records are auto-extracted and **pending**; the connection
  layer is therefore "candidate," not "verified." Closing this is human + permission
  work, not code.
- **Portraits:** a dignified, rights-gated portrait slot exists but no images are cleared,
  so none are shown.
