# Audit — Phase 1 (doc 12)

Repository and live-site audit for **Crestwood OHP — Survivor Journeys**.
Live Worker: `https://ohpmap.alexdong0414.workers.dev/` · Source of truth:
`https://ohp.crestwood.on.ca`.

## Architecture (how it actually works)

```
WordPress archive (ohp.crestwood.on.ca)
  └─ HTML scrape of /ohp-type/holocaust-survivors/  (REST CPT is NOT exposed)
        │  pipeline/scrape_ohp.py  →  data/source/ohp_scraped.json
        ▼
  Python build pipeline (pipeline/)
    scrape → extract (gazetteer-grounded) → geocode (committed cache)
    → review-gate (pending vs reviewed) → validate (JSON-Schema) → emit
        │  data/survivors.geojson · place_index.json · connections.json
        ▼
  Static front end (index.html + js/ + css/ + vendor/, all ES modules, no build)
    Leaflet + CARTO Positron + markercluster + SnakeAnim + Scrollama
    Modes: Guided / Explore / Patterns + time scrubber
        │
        ▼
  Delivery: Cloudflare Worker (worker/, wrangler.toml) — a [build] step assembles a
  clean public/ dir; the Worker serves it; an optional KV+Cron path auto-updates.
  GitHub Actions (.github/workflows/build.yml) validates + can deploy to Pages.
```

The front end only ever fetches three precomputed JSON files; nothing is scraped,
geocoded, or extracted at page-load. `js/data.js#loadData()` fetches
`data/survivors.geojson`, `place_index.json`, and `connections.json`.

## The "0 journeys" report — traced and resolved

**Symptom:** the live site reportedly showed "0 journeys" with three bare tabs.

**Root cause (historical):** the front-end counter (`#survivor-count`) is populated by
JS from `data/survivors.geojson`. Earlier in the project that file held only the
fictional fixture (or the Worker served a clean shell before real data was committed),
so the counter read 0. There was **no actual loader bug** — the data path in
`js/data.js` is correct; the file simply hadn't been populated/deployed yet.

**Current state (verified):** the committed dataset holds **221 real survivors** scraped
from the archive, and the deployed Worker serves it:

```
GET https://ohpmap.alexdong0414.workers.dev/data/survivors.geojson
→ 200, application/geo+json, 695 KB, metadata.count = 221
```

A headless load of the live URL renders `#survivor-count = 221` with **zero console
errors**. So the data blocker is closed. What remained was the *second* problem below.

## The real, still-valid problem at audit time: first-time clarity

Even with data loading, the site dropped a first-time visitor straight into the Guided
scroll with **no hero, no one-sentence purpose, no sense of scale, and no clear first
action**. A stranger could not tell what the site was or what to do. This is an
information-architecture / onboarding gap, not a data bug — and it is what the Phase 2
evaluation and the rebuild target.

## Secondary findings

- **Design system was thin:** system-font stack, a two-accent palette, ad-hoc spacing.
- **No explicit empty / loading / error states** for the map.
- **No About/methodology surface** explaining how journeys were derived or why records
  are "pending" — important given the subject matter.
- **A latent CSS bug:** components using the `hidden` attribute also set `display`
  (`.modal`, `.topbar`, `.layout`), which overrides `hidden` — leaving an invisible
  full-screen modal intercepting clicks. (Fixed in the rebuild via a global
  `[hidden]{display:none!important}` guard.)
