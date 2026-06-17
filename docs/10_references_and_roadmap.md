# 10 — References, Repositories & Roadmap

What "100× more impressive" actually looks like, where to learn it, and the order to
do it in. This is your inspiration + resource library. Two companion files go with
it: `11_claude_design_brief.md` (paste into Claude Design to get a beautiful visual)
and `12_github_copilot_instructions.md` (paste into GitHub Copilot to drive the
code changes).

> **Read-back of your intent:** a beautiful, dignified, instantly-understandable
> memorial map that auto-updates from the OHP archive — where a first-time visitor
> immediately grasps what it is, is pulled into one life, then explores many. If
> that's wrong, say so; everything below aims at that target.

---

## First, the two real problems with the live site

1. **It says "0 journeys" — it's empty.** No data is loading, so there is nothing to
   look at. This is why it feels confusing: there's a title, three bare tab words
   (Guided / Explore / Patterns), and a credits paragraph, and nothing else. Fixing
   the data (see `09`) is prerequisite to *any* visual work.
2. **The landing gives a first-timer nothing to grasp.** No one-sentence "what is
   this," no clear first action, no sense of scale ("N survivors, N journeys"), no
   emotional hook. A stranger bounces. The design brief (`11`) fixes this directly.

A note on scope you should decide now: the OHP archive has several categories —
Holocaust Survivors, Military Veterans, Community Members, and more. Your map is
"Survivor Journeys" (Holocaust survivors). Recommendation: **keep v1 to Holocaust
survivors** (the cleanest journey arc), but build the data pipeline to read the
whole `ohp-type` taxonomy so adding Veterans later is a config change, not a rewrite.

---

## A. The closest analog — study this one hardest

**Arolsen Archives — Transnational Remembrance (TransRem)**
https://transrem.arolsen-archives.org/
A digital interactive world map tracing 1,700+ life paths from birthplace → forced
labor → emigration, with filters to view one person or whole groups (e.g. everyone
born in Minsk). This is your project, executed by a major institution. Reverse-
engineer its: onboarding (how it tells you what it is), filter UI, how it draws a
single path vs. the whole network, and how it stays dignified while being
interactive.

## B. Memorial references (for tone, dignity, and the "individual first" idea)

- **Stolpersteine** (Gunter Demnig) — https://en.wikipedia.org/wiki/Stolperstein —
  the world's largest decentralized memorial. The core idea worth stealing: each
  memorial sits at *the last place the person freely chose to live*, inscribed
  "Here lived…", insisting the victim was a specific person in a specific place, not
  an anonymous statistic. Your map's whole thesis in one design principle.
- **USHMM Mapping Initiative** — https://www.aaas.org/programs/scientific-responsibility-human-rights-law/us-holocaust-memorial-museum-mapping-initiative — animated, georeferenced historical maps; a model for serious visual language.
- **USC Shoah Foundation / Dimensions in Testimony** and **Yad Vashem** — for how
  institutions present testimony with restraint (from your earlier research docs).

## C. World-class visual craft (for pacing, motion, and restraint)

These aren't memorials, but they're where you learn the *craft* of holding a
stranger's attention with data:

- **NYT "Snow Fall: The Avalanche at Tunnel Creek"** — the piece that defined
  scrollytelling; study how text and visuals hand off.
- **The Pudding** — https://pudding.cool — visual essays where data carries the
  weight. The lesson their own editors preach: **restraint beats spectacle — not
  every section needs animation.** Exactly right for your subject.
- **NBC News segregation maps (1930–2019)** — a Webby winner; scroll-driven maps
  over time, very close to your time-scrubber idea.
- **Reuters Graphics** — https://www.reuters.com/graphics/ — gold standard for
  map-and-data investigations; study their muted palettes and labeling.
- **Information is Beautiful Awards** — https://www.informationisbeautifulawards.com
  — a browsable gallery of the year's best, for ambient taste-building.

## D. Repositories to fork or study

| Repo | What it gives you | Notes |
|------|-------------------|-------|
| `mapbox/storytelling` (https://github.com/mapbox/storytelling) | Config-driven scrollytelling map: chapters with camera `center/zoom/pitch/bearing`, marker + layer toggles. Cinematic camera moves. | Live demo at labs.mapbox.com/storytelling. **Caveat:** Mapbox GL JS v2+ is not open source — use **MapLibre GL** (open fork) for an enduring memorial. The *config pattern* still applies. |
| `ONSvisual/income-scrolly` (https://github.com/ONSvisual/income-scrolly) | A government-grade scrollytelling article: **Svelte + MapLibre/Mapbox + Layer Cake**. Professional structure. | The UK statistics office's actual production code. Great architecture to learn from. |
| `russellsamora/scrollama` (https://github.com/russellsamora/scrollama) | The scroll-trigger engine (IntersectionObserver). | You likely already use this via HandsOnDataViz; learn its API directly. |
| `HandsOnDataViz/leaflet-storymaps-with-google-sheets` | Your current base for the guided view. | Keep, but restyle hard (see `11`). |
| deck.gl examples (https://deck.gl/examples) | `ArcLayer` (raised journey arcs), `GlobeView`, `TripsLayer` (animated trips over time). | The "wow" layer for Patterns + scrubber. Interleaves with MapLibre. |
| MapLibre examples (https://maplibre.org/maplibre-gl-js/docs/examples/) | Globe projection, 3D terrain, clustering, range-slider, feature-state hover. | Copy-paste-able patterns for almost every feature you want. |
| `willymaps/sveltemapscroll` (https://github.com/willymaps/sveltemapscroll) | A compact Svelte + Mapbox scrollytelling example. | Good if you go the Svelte route. |

**Architecture decision this surfaces:** your guided scrollytelling experience wants
to be a **full-page standalone** (the Mapbox/ONS pattern explicitly notes scroll
stories don't embed well in an iframe), while the Explore map *can* be embedded. So
plan two entry points: a full-page "Follow one journey" story, and an embeddable
"Explore the map." The OHP homepage links to the former and can iframe the latter.

## E. Skills to build (mapped to what you're making)

1. **MapLibre GL JS** — the modern, open, GPU-rendered map engine (globe, 3D,
   custom styles). The single highest-leverage skill upgrade from plain Leaflet.
2. **Scrollama / IntersectionObserver** — binding scroll position to map state.
3. **Custom map styling** — a desaturated style + optional historical overlay; this
   is most of what makes it look museum-grade.
4. **deck.gl layers** — arcs, trips, globe for the aggregate views.
5. **CSS architecture** — design tokens (color/space/type variables), responsive
   layout, focus/hover states, `prefers-reduced-motion`.
6. **Web typography** — pairing a humanist serif (names/quotes) with a clean sans
   (UI); rhythm and spacing.
7. **Cloudflare Workers: KV + Cron** — the auto-update pipeline (see `09`).
8. **Data/GeoJSON modeling** — the schema from `02`.
9. **Accessibility** — keyboard nav, ARIA, contrast, screen-reader testing.
10. **Git hygiene + small PRs** — so Copilot's changes stay reviewable.

## F. The roadmap (order of operations)

1. **Unblock data** (`09` Part 1): fix "0 journeys" with 5 real survivors. Nothing
   visual matters until something renders.
2. **Get the design** (`11`): run the Claude Design brief; produce a cohesive visual
   system + screen mockups (landing, guided, explore, patterns, survivor card).
3. **Rebuild the landing** so a stranger understands it in 5 seconds (hero +
   one-line purpose + clear first action + scale counter).
4. **Restyle to the design system**: MapLibre desaturated style, typography, color
   tokens, motion principles.
5. **Add the signature effect**: self-drawing journey lines (SnakeAnim) or deck.gl
   arcs.
6. **Wire auto-update** (`09` Part 2): Cron + KV pulling the full taxonomy.
7. **Flesh out Explore + Patterns + scrubber** on the full dataset.
8. **Accessibility + performance + mobile pass.**
9. **Two entry points** for the OHP site: full-page story + embeddable explore.

Use `12` (Copilot instructions) to execute steps 1 and 3–8 in code; use `11`
(Claude Design) to produce step 2 first so the code has a target to build to.
