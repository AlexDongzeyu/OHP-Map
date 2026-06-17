# Crestwood OHP — Survivor Journeys

An interactive, self-updating memorial map of Holocaust survivor journeys from the
**Crestwood Oral History Project** (`ohp.crestwood.on.ca`). It turns 200 testimonies
that are stored alphabetically — and so hide their own patterns — into three lenses on
one dataset: a **Guided** scrollytelling intro, a free **Explore** map, and a
**Patterns** view that surfaces where journeys crossed. A **time scrubber** (1933–1950)
lets you watch dots converge on the same camp in the same year.

> ### ⚠️ This build ships with FICTIONAL sample data
> Every survivor shown here (`Rosa Blum (sample)`, `David Stern (sample)`, …) is
> **illustrative, invented data**, not real testimony. That is deliberate. The source
> documents treat three things as hard requirements: **written permission before any
> ingest**, **human verification before any fact is published**, and **rights clearance
> for every quote and portrait**. None of those can be satisfied by an automated build,
> so publishing real survivors' data here would violate the project's own ethics. The
> system is complete and runs end-to-end; swap in reviewed, permission-cleared data to
> go live (see [Going live with real data](#going-live-with-real-data)).

The full design rationale lives in [`docs/`](docs/) (the planning dossier, files
`00`–`08`). This README is the handoff: how it works, how to run it, how to extend it.

---

## The one-paragraph version

A first-time visitor lands in a **guided** walk through one survivor's journey — the map
pans and the route draws itself as they scroll. They then enter **Explore**: every
survivor is a clustered dot at their hometown on a quiet CARTO Positron basemap; click
one for a side panel (bio, journey, the place names *as the survivor said them*, a link
to the archive); click a place and everyone connected to it lights up; a filter bar
replaces the archive's broken search. **Patterns** shows the aggregate — flow lines,
origin density, and the verified **connection layer** (people who were in the same place
at the same time). WordPress stays the content backend; a CI pipeline rebuilds the map
when new content is published, with no manual work.

---

## Quick start (offline, ~2 minutes)

```bash
# 1. Build the dataset (offline; regenerates the committed sample data)
pip install -r pipeline/requirements.txt
python -m pipeline.build

# 2. Serve the static site
python -m http.server 8124
#   open http://localhost:8124
```

That's the whole product: open the URL, try the three tabs, drag the scrubber to 1944.

Run the tests with `python -m pytest -q` (25 tests: normalization, fuzzy dates,
waypoint ordering, index/connection building, the golden extraction set, and an
end-to-end schema-valid build).

A headless browser smoke test is in `tools/smoke.cjs`
(`node tools/smoke.cjs` against a running server, uses puppeteer-core + Edge).

---

## Architecture

```
WordPress (ohp.crestwood.on.ca)         ← source of truth, never written to
        │  REST API (/wp-json/wp/v2/…)          [Plan A]
        │  or HTML scrape                        [Plan B fallback]
        ▼
┌───────────────────────────────────────────────┐
│  Build pipeline (Python — pipeline/)           │
│  ingest → extract → normalize → REVIEW GATE →  │
│  geocode (cached) → validate → emit JSON       │
└───────────────────────────────────────────────┘
        │  survivors.geojson + place_index.json + connections.json
        ▼
┌───────────────────────────────────────────────┐
│  Static front end (index.html + js/ + vendor/) │
│  Leaflet + CARTO Positron + Scrollama          │
│  Guided / Explore / Patterns + time scrubber   │
└───────────────────────────────────────────────┘
        │  GitHub Actions → GitHub Pages
        ▼
   <iframe> on the OHP homepage  (see embed.html)
```

**Key principle — decouple data from render.** The browser only ever loads precomputed
JSON. No geocoding, scraping, or NLP happens at page load. That's what makes it fast,
free to host, and resilient.

---

## The pipeline (`pipeline/`)

One command, several swappable stages behind clean interfaces:

| Module | Job |
|--------|-----|
| `ingest.py` | `WordPressRestSource` (Plan A) · `HtmlScrapeSource` (Plan B) · `LocalSource` (the bundled anchors), one `Source` interface |
| `extract.py` | `LLMExtractor` (Claude/GPT, prompted for **strict JSON**, every place **grounded** in the source text) · `OfflineExtractor` (deterministic, key-free fallback) |
| `gazetteer.py` | Historical exonym → canonical name (Lemberg → Lviv) + known camp/ghetto force-match |
| `geocode.py` | Canonical name → coordinates, from a **committed cache**; live Nominatim only with `--allow-network`, throttled 1 req/s |
| `dates.py` | Fuzzy-date helpers (a place is active over a *year range*, never fake day-precision) |
| `derive.py` | Waypoint ordering · `place_index.json` · the verified `connections.json` |
| `validate.py` | JSON-Schema + semantic checks; **the build raises on any invalid record** |
| `review.py` | The human-review gate: queues every unverified item, publishes only verified ones |
| `build.py` | Orchestrates all of the above |

```bash
python -m pipeline.build                 # offline sample build (default)
python -m pipeline.build --discover      # probe the WP REST API and exit
python -m pipeline.build --source wordpress --extractor anthropic --allow-network
```

### The review gate is load-bearing

`build.py` runs `review.emit_review_queue()` (→ `data/review/review_queue.csv`) for
**every** unverified or low-confidence waypoint, then `review.filter_published()` keeps
**only** `verified: true` records for the map. Extractor output is *never* auto-trusted.
You — a human, sitting with the testimony — are the gate (doc 04 guardrail #2).

---

## The front end (`index.html`, `js/`, `css/`, `vendor/`)

Vanilla ES modules, no build step. Libraries are **vendored and pinned** in `vendor/`
(no fragile CDNs). One Leaflet map; each mode adds/removes its own layers.

| File | Responsibility |
|------|----------------|
| `js/config.js` | The restrained palette, basemap, roles, reduced-motion flag |
| `js/data.js` | Loads the three JSON artifacts; builds lookups + filter facets |
| `js/mapcore.js` | Map + Positron basemap + marker / journey-line factories |
| `js/guided.js` | Scrollytelling (Scrollama) with the self-drawing journey line (SnakeAnim) |
| `js/explore.js` | Clustered dots, side panel, click-a-place index, filter bar |
| `js/patterns.js` | Flow lines, origin density, the connection layer |
| `js/scrubber.js` | The 1933–1950 time scrubber; fuzzy positions shown soft |
| `js/app.js` | Mode switching, hash deep links, scrubber wiring |

**Deep links:** `#/guided`, `#/explore`, `#/patterns`, `#/survivor/<id>`,
`#/place/<slug>` — a teacher can send a class straight to one story or place.

**Accessibility (doc 02 N1):** keyboard-navigable tabs, a focusable survivor list that
mirrors the map for non-mouse users, ARIA labels on markers/panels, a skip link, AA-
contrast palette, and a fully honored `prefers-reduced-motion` (SnakeAnim and map eases
turn off, the scrubber still works).

**Tone (doc 08):** quiet CARTO Positron basemap, one muted accent for journeys and one
for the active state, grayscale otherwise; slow non-looping motion; no 3D camp
reconstructions, no "war" styling, no decorative face collages. The 2D accessible map is
the canonical product.

---

## Data model (`data/`)

`survivors.geojson` — a GeoJSON `FeatureCollection`, one Feature per survivor, point
geometry at the hometown (coordinate order **`[lng, lat]`**). Each waypoint keeps both
the **as-written** name and the **canonical** one:

```jsonc
{
  "as_written": "Lemberg",
  "canonical":  "Lviv, Ukraine",
  "role": "birthplace",               // birthplace|ghetto|camp|transit|liberation|resettlement
  "lat": 49.8397, "lng": 24.0297,
  "date": { "start": "1925", "end": "1925", "precision": "year" },
  "confidence": 1.0,
  "verified": true,
  "source_quote": "I was born in Lemberg in 1925."
}
```

Also emitted: `place_index.json` (`canonical place → [survivor_id]`) and
`connections.json` (verified `{place, survivorA, survivorB, overlap_window}`).
`geocode_cache.json` is committed so rebuilds are reproducible. `data/golden/` holds the
hand-checked extraction ground truth. Validated against `data/schema/survivors.schema.json`.

---

## CI/CD & deployment

`.github/workflows/build.yml` runs on **push** (validate), a weekly **schedule**,
**workflow_dispatch** (manual rebuild), and **repository_dispatch** (a WordPress publish
webhook, type `ohp-publish`). Each run: install → `pytest` → `pipeline.build` → commit
changed JSON (scheduled/dispatch only) → assemble `_site` → deploy to **GitHub Pages**.
The build *fails on invalid data*, so bad data can't deploy. The LLM key lives in
`secrets.ANTHROPIC_API_KEY`, never in the repo.

**Enable Pages:** repo *Settings → Pages → Build and deployment → Source: GitHub Actions*.
**Embed for Mr. Masters:** paste [`embed.html`](embed.html) (one `<iframe>`) onto any
WordPress page — he changes nothing else.

---

## Going live with real data

1. **Permission first.** Get Mr. Masters' written OK and a sensitivity check (E1).
2. **Point the pipeline at WordPress:** `python -m pipeline.build --discover` to confirm
   the REST API exposes the post type, then run with `--source wordpress --extractor
   anthropic --allow-network` (set `ANTHROPIC_API_KEY`).
3. **Work the review gate.** Open `data/review/review_queue.csv`, sit with each
   testimony, and only mark waypoints `verified` once you've confirmed them. This is the
   slow, human, important part.
4. **Clear rights** for any quote or portrait before it goes online (E-rules, doc 08 #2).
5. Replace the sample `data/source/survivors_source.json` with reviewed records (keep the
   bundled ones as your golden set / regression fixtures).

---

## Project structure

```
index.html  embed.html              static entry + the one-line embed
css/  js/  vendor/  assets/          front end (vendored, pinned libs)
data/        survivors.geojson, place_index.json, connections.json,
             geocode_cache.json, gazetteer.json, schema/, golden/, source/, review/
pipeline/    the Python build pipeline (see table above)
tests/       pytest suite (run: python -m pytest)
tools/       headless smoke test + screenshot helpers (puppeteer-core)
docs/        the planning dossier (00–08): concept, SDLC, tools, prompts, ethics
.github/     CI build + deploy workflow
```

---

## Requirements traceability

| | Requirement | Where |
|---|---|---|
| F1–F3 | Ingest, extract, normalize + geocode | `pipeline/ingest,extract,gazetteer,geocode` |
| F4–F6 | Dots, survivor panel, click-a-place | `js/explore.js`, `place_index.json` |
| F7 | Filter bar | `js/explore.js` |
| F8 | Guided scrollytelling | `js/guided.js` (Scrollama + SnakeAnim) |
| F9 | Patterns: flows, density, connections | `js/patterns.js`, `connections.json` |
| F10 | Time scrubber 1933–1950 | `js/scrubber.js` |
| F11 | Deep links | `js/app.js` |
| F12 | Automated rebuild | `.github/workflows/build.yml` |
| N1–N6 | a11y, perf (clustering), mobile, reproducibility, maintainability, resilience | front end + committed cache + CI validation |
| E1–E5 | Permission, human review, honest uncertainty, original names kept, no new aggregate exposure | the review gate, fuzzy dates, `as_written` everywhere, sample-only build |

---

## Credits & licenses

This is a student project. The **Guided** view adapts the idea of HandsOnDataViz
[*Leaflet Storymaps with Google Sheets*](https://github.com/HandsOnDataViz/leaflet-storymaps-with-google-sheets)
by **Ilya Ilyankou & Jack Dougherty**; the **Explore / Patterns / scrubber** app is
custom. Built on **Leaflet** (BSD-2-Clause) with **Leaflet.markercluster** (MIT),
**Leaflet.Polyline.SnakeAnim** (Beerware), and **Scrollama** (MIT). Basemap tiles
© OpenStreetMap contributors © CARTO. See [`LICENSE`](LICENSE). Code in this repo is MIT.

Made with restraint, in memory of those whose journeys these are.
