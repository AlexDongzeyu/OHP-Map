# Crestwood OHP — Survivor Journeys

An interactive memorial map of Holocaust survivor journeys from the **Crestwood Oral
History Project** (`ohp.crestwood.on.ca`). It turns 200+ testimonies that are stored
alphabetically — and so hide their own patterns — into three lenses on one dataset: a
**Guided** scrollytelling intro, a free **Explore** map, and a **Patterns** view that
surfaces where journeys may cross. A **time scrubber** (1933–1950) lets you watch dots
converge on the same camp in the same year.

**Live data:** the map is populated with **221 real survivors** scraped from the public
OHP archive, their journeys auto-extracted from each public bio.

> ### ⚠️ Read this: the data is *pending review*, not authoritative
> The `ohp` WordPress post type is **not** exposed over the REST API (`/wp-json/wp/v2/ohp`
> returns `rest_no_route`), so the pipeline uses the documented **HTML-scrape fallback**.
> Journeys are **auto-extracted from public bio summaries** and every record is
> `verified: false` (**pending**). Per the project's ethics (docs 04 / 08 / 09), nothing
> here is asserted as fact: a human must verify each journey against the full testimony,
> **and Mr. Masters must give written permission**, before any record is marked reviewed.
> The UI says so prominently, "same place, same time" links are shown as **candidates**
> ("not a claim that they met"), and original place spellings are always preserved. Treat
> every pin as a pointer to the full archive entry, not a final record.

The full design rationale lives in [`docs/`](docs/) (the planning dossier, files
`00`–`09`). Doc 09 is the live-site finish guide this build implements. This README is
the handoff: how it works, how to run it, how to extend it.

---

## The one-paragraph version

A first-time visitor lands in a **guided** walk through one survivor's journey (Martin
Baranek: Starachowice → Auschwitz → Gunskirchen → Canada) — the map pans and the route
draws itself as they scroll. They then enter **Explore**: every survivor is a clustered
dot at their hometown on a quiet CARTO Positron basemap; click one for a side panel (bio,
journey, the place names *as the archive wrote them*, a link back to the entry); click a
place and everyone connected to it lights up; a filter bar replaces the archive's broken
search. **Patterns** shows the aggregate — flow lines, origin density, and the **candidate
connection layer**. WordPress stays the content backend; the dataset rebuilds from it
automatically (GitHub Actions *or* a Cloudflare Worker), with no manual work.

---

## Quick start (offline, ~2 minutes)

```bash
# 1. Build the dataset (offline; rebuilds the real data from committed artifacts)
pip install -r pipeline/requirements.txt
python -m pipeline.build            # default source = ohp (221 real survivors)

# 2. Serve the static site
python -m http.server 8124
#   open http://localhost:8124
```

That's the whole product: open the URL, try the three tabs, drag the scrubber to 1944 and
watch the dots converge on Auschwitz.

Other builds:

```bash
python -m pipeline.scrape_ohp --refresh   # re-pull all pages from the live archive
python -m pipeline.build --source local   # the fictional fixture set (used by tests)
python -m pipeline.build --strict         # publish only human-reviewed records
python -m pipeline.build --discover       # probe the WP REST API and exit
```

Run the tests with `python -m pytest -q` (32 tests). A headless browser smoke test is in
`tools/smoke.cjs` (`node tools/smoke.cjs` against a running server; puppeteer-core + Edge).

---

## Architecture

```
WordPress (ohp.crestwood.on.ca)         ← source of truth, never written to
        │  REST API (/wp-json/wp/v2/ohp)   → 404 rest_no_route   [Plan A unavailable]
        │  HTML scrape of /ohp-type/holocaust-survivors/         [Plan B — in use]
        ▼
┌───────────────────────────────────────────────┐
│  Build pipeline (Python — pipeline/)           │
│  scrape → extract → normalize → REVIEW GATE →  │
│  geocode (cached) → validate → emit JSON       │
└───────────────────────────────────────────────┘
        │  survivors.geojson + place_index.json + connections.json
        ▼
┌───────────────────────────────────────────────┐
│  Static front end (index.html + js/ + vendor/) │
│  Leaflet + CARTO Positron + Scrollama          │
│  Guided / Explore / Patterns + time scrubber   │
└───────────────────────────────────────────────┘
        │  GitHub Actions  ─or─  Cloudflare Worker (cron + KV)
        ▼
   <iframe> on the OHP homepage  (see embed.html)
```

**Key principle — decouple data from render.** The browser only ever loads precomputed
JSON. No scraping, geocoding, or NLP happens at page load. That's what makes it fast, free
to host, and resilient.

---

## The pipeline (`pipeline/`)

| Module | Job |
|--------|-----|
| `scrape_ohp.py` | **Plan B ingest** — scrapes the survivor listing + each `/ohp/{slug}/` page (name + bio), caching HTML to disk. Emits `data/source/ohp_scraped.json`. |
| `ingest.py` | One `Source` interface: `ohp` (curated featured + scraped, default), `local` (fictional fixture), plus `wordpress`/`scrape`/`scraped`. |
| `extract.py` | `LLMExtractor` (Claude/GPT, strict JSON, **every place grounded** in the source text) + `OfflineExtractor` (deterministic, key-free; alias-matches the gazetteer and assigns roles). |
| `gazetteer.py` | Historical exonym → canonical (Lemberg → Lviv) + known camp/ghetto force-match. 69 places / 144 aliases, generated by `tools/build_gazetteer.py`. |
| `geocode.py` | Canonical name → coordinates from a **committed cache**; live Nominatim only with `--allow-network` (1 req/s). |
| `dates.py` | Fuzzy-date helpers (a stop is active over a *year range*, never fake day-precision). |
| `derive.py` | Waypoint ordering (chronological, with neighbour-fill + role fallback) · `place_index.json` · the connection layer. |
| `validate.py` | JSON-Schema + semantic checks; **the build raises on any invalid record**. |
| `review.py` | The human-review gate: queues every pending item and tags `review_status`. |
| `build.py` | Orchestrates all of the above. |

### The review gate is load-bearing

`build.py` emits `data/review/review_queue.csv` for **every** unverified waypoint, then
`review.stage()` labels each survivor `reviewed` or `pending`. Extractor output is never
auto-trusted — a human (with Mr. Masters' permission) is the gate (doc 04 guardrail #2).
The front end renders `pending` records honestly and the connection layer marks unverified
overlaps as **candidates**.

---

## The front end (`index.html`, `js/`, `css/`, `vendor/`)

Vanilla ES modules, no build step. Libraries are **vendored and pinned** in `vendor/` (no
fragile CDNs). One Leaflet map; each mode adds/removes its own layers.

| File | Responsibility |
|------|----------------|
| `js/config.js` | The restrained palette, basemap, period-overlay, roles, reduced-motion flag |
| `js/data.js` | Loads the three JSON artifacts; builds lookups + filter facets |
| `js/mapcore.js` | Map + Positron basemap + layer control (incl. optional period place-names) + marker/line factories |
| `js/guided.js` | Scrollytelling (Scrollama) with the self-drawing journey line (SnakeAnim) |
| `js/explore.js` | Clustered dots, side panel, click-a-place index, filter bar, dignified portrait slot |
| `js/patterns.js` | Flow lines, origin density, the candidate/verified connection layer |
| `js/scrubber.js` | The 1933–1950 time scrubber; fuzzy positions shown soft |
| `js/app.js` | Mode switching, hash deep links, the pending/sample notice banner |

**Deep links:** `#/guided`, `#/explore`, `#/patterns`, `#/survivor/<id>`, `#/place/<slug>`.

**Visual polish (doc 09 Part 3):** self-drawing SnakeAnim journey lines; an optional faint
period place-names overlay (OpenHistoricalMap, off by default — accurate cartography, not a
"war" look); marker clustering for 200+ dots; a serif for names/quotes; a faint map
vignette; grayscale-to-colour portrait slot (rights-gated); slow non-looping motion.

**Accessibility (doc 02 N1):** keyboard-navigable tabs, a focusable survivor list mirroring
the map, ARIA labels, a skip link, AA-contrast palette, and a fully honoured
`prefers-reduced-motion`.

---

## Data model (`data/`)

`survivors.geojson` — a GeoJSON `FeatureCollection`, one Feature per survivor, point
geometry at the hometown (coordinate order **`[lng, lat]`**). Each waypoint keeps both the
**as-written** name and the **canonical** one. Properties also carry `review_status`
(`pending`/`reviewed`) and `featured`. Also emitted: `place_index.json`
(`canonical place → [survivor_id]`) and `connections.json` (each with a `verified` flag).
`geocode_cache.json` + `data/source/ohp_scraped.json` are committed so rebuilds are
reproducible and offline. Validated against `data/schema/survivors.schema.json`.

---

## Auto-update — two interchangeable paths

Both rebuild the dataset from the archive with **zero page-load cost**; new survivors are
staged `pending`, never auto-published as fact (doc 09 Step 2.5).

**A. GitHub Actions** (`.github/workflows/build.yml`) — on push (validate), a weekly
schedule, `workflow_dispatch` (manual), and `repository_dispatch` (a WordPress publish
webhook, type `ohp-publish`). Each run: `pytest` → `pipeline.build` → commit changed JSON →
deploy to GitHub Pages. The build *fails on invalid data*.

**B. Cloudflare Worker** (`wrangler.toml`, `worker/`) — the Cloudflare-native option from
doc 09. A **Cron Trigger** fires `scheduled()`, which scrapes the archive, diffs against
**Workers KV**, enriches only NEW survivors (reusing the committed gazetteer + geocode
cache), and writes the merged GeoJSON to KV. `fetch()` serves the site and the dataset
straight from KV — no external call on page load.

```bash
npx wrangler kv namespace create OHP_DATA   # paste the id into wrangler.toml
npx wrangler dev --test-scheduled           # then GET /__scheduled or /__sync to test
npx wrangler deploy
```

The LLM key (when the LLM extractor is used) lives in CI/Worker secrets, never in the repo.
**Embed for Mr. Masters:** paste [`embed.html`](embed.html) (one `<iframe>`) — nothing else
changes in WordPress.

---

## Going further: promoting a record from pending to reviewed

1. **Permission first.** Mr. Masters' written OK + a sensitivity check (E1).
2. Open `data/review/review_queue.csv`, sit with each testimony, confirm the places/dates.
3. Move the confirmed survivor into `data/source/survivors_curated.json` with
   `"verified": true` on each checked waypoint; rebuild. It now renders as **reviewed**,
   and any place+time overlap with another reviewed survivor becomes a **verified**
   connection (not a candidate).
4. Clear rights for any quote or portrait before it goes online (doc 08 #2).

---

## Project structure

```
index.html  embed.html              static entry + the one-line embed
css/  js/  vendor/  assets/          front end (vendored, pinned libs)
data/        survivors.geojson, place_index.json, connections.json, geocode_cache.json,
             gazetteer.json, schema/, golden/, review/, source/ (ohp_scraped + curated)
pipeline/    the Python build pipeline (incl. scrape_ohp.py)
worker/      Cloudflare Worker (scheduled sync + KV-served fetch)
wrangler.toml
tests/       pytest suite (run: python -m pytest)
tools/       build_gazetteer.py + headless smoke/screenshot helpers
docs/        the planning dossier (00–09)
.github/     CI build + deploy workflow
```

---

## Requirements traceability

| | Requirement | Where |
|---|---|---|
| F1–F3 | Ingest (scrape), extract, normalize + geocode | `pipeline/scrape_ohp,extract,gazetteer,geocode` |
| F4–F6 | Dots, survivor panel, click-a-place | `js/explore.js`, `place_index.json` |
| F7 | Filter bar | `js/explore.js` |
| F8 | Guided scrollytelling | `js/guided.js` (Scrollama + SnakeAnim) |
| F9 | Patterns: flows, density, connections | `js/patterns.js`, `connections.json` |
| F10 | Time scrubber 1933–1950 | `js/scrubber.js` |
| F11 | Deep links | `js/app.js` |
| F12 | Automated rebuild | `.github/workflows/build.yml` + `worker/` |
| N1–N6 | a11y, perf (clustering), mobile, reproducibility, maintainability, resilience | front end + committed cache + CI/Worker validation |
| E1–E5 | Permission, human review, honest uncertainty, original names kept, no new aggregate exposure | the review gate + pending labels, candidate connections, fuzzy dates, `as_written` everywhere |

---

## Credits & licenses

A student project. The **Guided** view adapts the idea of HandsOnDataViz
[*Leaflet Storymaps with Google Sheets*](https://github.com/HandsOnDataViz/leaflet-storymaps-with-google-sheets)
by **Ilya Ilyankou & Jack Dougherty**; the **Explore / Patterns / scrubber** app and the
ingest/extraction pipeline are custom. Built on **Leaflet** (BSD-2-Clause),
**Leaflet.markercluster** (MIT), **Leaflet.Polyline.SnakeAnim** (Beerware), and
**Scrollama** (MIT). Basemap © OpenStreetMap contributors © CARTO; optional period overlay
© OpenHistoricalMap contributors. Testimony content belongs to the Crestwood OHP and the
survivors and families — used here only as short excerpts linking back to the archive. See
[`LICENSE`](LICENSE). Code in this repo is MIT.

Made with restraint, in memory of those whose journeys these are.
