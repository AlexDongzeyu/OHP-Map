# 12 — GitHub Copilot Instructions

> Paste everything below the line into GitHub Copilot Chat (use **agent mode** in VS
> Code if available, with the repo open). It's self-contained: the reference
> projects and patterns are embedded so you don't have to rely on web browsing.

---

You are helping improve a **deployed** interactive memorial map: "Crestwood OHP —
Survivor Journeys." It maps the journeys of Holocaust survivors interviewed by
Crestwood Preparatory College students. It's live on Cloudflare Workers at
`https://ohpmap.alexdong0414.workers.dev/` and the data source of truth is the
WordPress archive at `https://ohp.crestwood.on.ca` (survivors are a custom post type
`ohp` under the taxonomy term `/ohp-type/holocaust-survivors/`, each at
`ohp.crestwood.on.ca/ohp/{slug}/`).

Work in phases. **Stop after each phase, show me the output, and wait for my
go-ahead.** Do not make large sweeping commits.

## Known facts about the current state
- The site renders a shell (title, three tab labels: Guided / Explore / Patterns, a
  credits paragraph) but reports **"0 journeys"** — i.e. no survivor data is
  loading. This is the #1 blocker.
- A first-time visitor cannot tell what the site is for from the landing screen.
- It's built on Leaflet + CARTO basemaps, adapting the HandsOnDataViz Leaflet
  Storymaps template, deployed as a Cloudflare Worker.

## PHASE 1 — Read & audit (no code changes yet)
1. Read the entire repository. Summarize the architecture: how the Worker serves the
   page, where the front-end JS lives, how/where it tries to load survivor data,
   what the data format is, and how it's deployed (`wrangler.toml`, assets/KV).
2. Reproduce the "0 journeys" bug on paper: trace the exact code path that loads data
   and identify why the result is empty (missing file? wrong fetch path? unconfigured
   static assets? empty/malformed data?). Name the most likely cause with file +
   line references.
3. Output your findings to `docs/audit.md`.

## PHASE 2 — Research & critically evaluate
Compare the current site against these reference projects and patterns (embedded so
you don't need to browse):
- **Arolsen Archives "TransRem"** (transrem.arolsen-archives.org): the closest
  analog — life paths from birthplace → camps → emigration, with filters for one
  person or whole groups. Note its onboarding, filters, and single-path vs.
  whole-network rendering.
- **Mapbox/MapLibre storytelling template** (github.com/mapbox/storytelling): a
  config-driven scrollytelling map where each chapter sets the camera
  (`center/zoom/pitch/bearing`) and toggles layers, producing cinematic transitions.
- **ONSvisual/income-scrolly** (github.com/ONSvisual/income-scrolly): production-grade
  scrollytelling with Svelte + MapLibre + Layer Cake.
- **Scrollama** (github.com/russellsamora/scrollama): IntersectionObserver-based
  scroll triggers.
- **deck.gl** `ArcLayer` / `TripsLayer` / `GlobeView`: raised journey arcs, animated
  trips over time, and a 3D globe overview — interleaves with MapLibre.
- **The Pudding** / **NYT "Snow Fall"** for pacing and the principle *restraint beats
  spectacle*.

Then critically evaluate: write `docs/evaluation.md` listing, with specifics, where
the current site falls short of these on (a) first-time clarity, (b) visual craft,
(c) motion/storytelling, (d) information architecture, (e) accessibility, and (f)
the empty/loading/error states. Be concrete and honest; cite files where relevant.

## PHASE 3 — Improvement plan
Write `docs/improvement-plan.md`: a prioritized, step-by-step plan to close the gaps,
ordered so the data blocker is fixed first and visual work follows. For each item:
the change, the files touched, the libraries involved, and an acceptance check.

## PHASE 4 — Implement, smallest-risk first (one PR per item)
Implement in this order, pausing for review between each:
1. **Fix "0 journeys":** make the Worker serve the data file correctly (configure
   static assets or read from KV) and load it on the client. Add 5 hand-entered real
   survivors as `data/survivors.geojson` if no data exists yet, using this schema:
   `{ survivor_id, name, bio_excerpt, archive_url, verified, waypoints:[{as_written,
   canonical, role, lat, lng, date:{start,end,precision}}] }`. The counter must show
   the real journey count.
2. **Rebuild the landing** so a stranger understands it in 5 seconds: a hero with the
   title, a one-sentence purpose, a clear primary action ("Follow one journey") and
   secondary ("Explore the map"), and a scale line ("N survivors · N journeys").
   Implement the visual design I provide separately (design tokens for color/type/
   spacing). Design empty + loading states for the map.
3. **Restyle to the design system:** desaturated basemap, the serif/sans type
   pairing, one accent color, generous spacing, slow eases, `prefers-reduced-motion`.
4. **Signature effect:** journey lines that draw themselves leg-by-leg
   (Leaflet.Polyline.SnakeAnim) — or migrate the map engine to MapLibre GL and use
   deck.gl `ArcLayer` for arcs. Recommend which, with tradeoffs, before doing it.
5. **Auto-update pipeline (Cloudflare-native):** a Cron Trigger + Workers KV. The
   `scheduled()` handler fetches the OHP REST API (`/wp-json/wp/v2/ohp?per_page=100`,
   paginated; fall back to scraping `/ohp-type/holocaust-survivors/` if the CPT
   isn't REST-exposed), diffs against KV to find new/changed survivors, enriches only
   those, and writes merged GeoJSON to KV; the `fetch()` handler serves from KV. New
   entries land as `verified:false` and are NOT presented as fact until reviewed.
6. **Explore + Patterns + time scrubber** on the full dataset (clustering, filters,
   arcs, scrubber). Build the whole-taxonomy ingest so Veterans can be added later.
7. **Accessibility + performance + mobile pass.**

## TOOLS & SKILLS to use
Wrangler (Cloudflare Workers CLI), Workers KV, Cron Triggers; Leaflet or MapLibre GL
JS; deck.gl; Scrollama; vanilla JS or Svelte; CSS custom properties for design
tokens; GeoJSON; pytest-style or vitest tests for data validation.

## GUARDRAILS (do not violate)
- **Restraint over spectacle.** This is a memorial. No 3D reconstructions of camps,
  no AR, no "war"-styled grunge, no decorative collages of faces, no autoplaying
  motion. Any 3D (globe/arcs) is an enhancement over an accessible 2D baseline.
- **Never present unverified data as fact.** `verified:false` records are held back
  or clearly labeled "approximate, pending review." Never fabricate places, dates,
  or that two people were "together"; phrase verified overlaps as "both describe
  being at X around <year>."
- **Rights:** only render photos/quotes we're cleared to use; prefer linking to the
  full archive entry over reposting testimony text.
- **Accessibility is a requirement,** not a nice-to-have: keyboard, ARIA, AA
  contrast, reduced-motion.
- **Small, reviewable commits** with clear messages; update `docs/` as you go;
  explain *why* for non-obvious choices and flag any bug or bad habit you find in the
  existing code.

## OUTPUT
Produce these Markdown files in `docs/`: `audit.md` (Phase 1), `evaluation.md`
(Phase 2), `improvement-plan.md` (Phase 3). Then implement Phase 4 items one PR at a
time, each with its acceptance check met. Begin with Phase 1 and stop for my review.
