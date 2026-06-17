# 02 — SDLC Plan

A realistic software development lifecycle for a solo high-school developer
building this around AP/IB coursework. The model is **iterative/incremental**, not
waterfall: each phase ends with something that runs. You always have a working
(if smaller) version, which de-risks everything and means you have a demo at any
point in your college-app timeline.

---

## 1. Stakeholders

| Stakeholder | Interest | What they need from you |
|-------------|----------|--------------------------|
| You (developer) | Portfolio piece, learning, the essay | A scoped project you can actually finish |
| Mr. Masters / Social Studies | A living archive, more reach | Zero change to how they add content; one-line embed |
| Survivors & families | Dignity, accuracy | Verified facts, preserved voice, restraint |
| Visitors (students, public) | Understanding | Clarity, accessibility, an emotional on-ramp |

If you remember only one stakeholder rule: **don't make Mr. Masters change his
workflow.** WordPress stays the source of truth; your system reads from it.

---

## 2. Requirements

### Functional (what it must do)
- F1. Ingest all "Holocaust Survivors" entries from the OHP archive.
- F2. Extract a structured journey per survivor (ordered places + role + approx date).
- F3. Normalize historical place names and geocode to coordinates.
- F4. Render survivors as dots at hometowns on a quiet basemap.
- F5. Click survivor → side panel (bio, journey line, as-written names, archive link).
- F6. Click place → list/highlight all survivors connected to it.
- F7. Filter bar (camp, origin, theme tag, free text) replacing the broken search.
- F8. Guided scrollytelling intro for one survivor's journey.
- F9. Patterns mode: flow lines, origin density, the connection layer.
- F10. Time scrubber animating positions across ~1933–1950.
- F11. Deep links to a survivor and to a place.
- F12. Automated rebuild when new content is published.

### Non-functional (how well it must do it)
- N1. **Accessibility:** WCAG 2.1 AA target; keyboard + screen reader; reduced motion.
- N2. **Performance:** smooth with 200+ markers on a mid-range phone (clustering).
- N3. **Mobile-first:** most visitors are on phones.
- N4. **Reproducibility:** a rebuild from the same source yields the same dataset.
- N5. **Maintainability:** a future student can run and extend it from the README.
- N6. **Resilience:** pipeline survives the REST API being unavailable (fallback).

### Ethical (non-negotiable, treated as hard requirements)
- E1. Written permission before ingest.
- E2. Human review before any extracted fact publishes.
- E3. Uncertainty represented honestly (no fabricated precision).
- E4. Original place names preserved alongside canonical ones.
- E5. No data exposed in aggregate that isn't already public on the archive.

### Out of scope (write it down so scope creep can't sneak in)
- Editing/CRUD of testimonies (that stays in WordPress).
- User accounts, comments, or any write-back to the archive.
- Hosting video; you link to or embed existing media, you don't re-host it.
- Non-Holocaust OHP categories in v1 (architecture should allow them later).

---

## 3. Architecture

```
WordPress (ohp.crestwood.on.ca)        ← source of truth, unchanged
        │  REST API (/wp-json/wp/v2/...)        [Plan A]
        │  or HTML scrape                        [Plan B fallback]
        ▼
┌─────────────────────────────────────────────┐
│  Build pipeline (Python, runs in CI)          │
│  1. Ingest      → raw testimony records       │
│  2. Extract     → LLM → structured journeys   │
│  3. Validate    → gazetteer + JSON schema     │
│  4. Review gate → human-confirm low-confidence│
│  5. Geocode     → canonical name → coords     │
│                   (cached, committed to repo) │
│  6. Emit        → survivors.geojson + indexes │
└─────────────────────────────────────────────┘
        │  static JSON artifacts
        ▼
┌─────────────────────────────────────────────┐
│  Static front end (HTML/CSS/JS)               │
│  Leaflet + Positron tiles + Scrollama         │
│  Modes: Guided / Explore / Patterns + scrubber│
└─────────────────────────────────────────────┘
        │  deployed to GitHub Pages / Netlify / Cloudflare Pages
        ▼
   <iframe> embed on the OHP homepage  ← one line for Mr. Masters
```

**Key principle: decouple data from render.** The browser only ever loads
precomputed JSON. No geocoding, scraping, or NLP happens at page-load. This is what
makes it fast, cheap (free static hosting), and resilient.

---

## 4. Data model

`survivors.geojson` — a GeoJSON `FeatureCollection`, one feature per survivor,
point geometry at the hometown:

```jsonc
{
  "type": "Feature",
  "geometry": { "type": "Point", "coordinates": [24.03, 49.84] },
  "properties": {
    "survivor_id": "rosa-blum",
    "name": "Rosa Blum",
    "bio_excerpt": "…",
    "archive_url": "https://ohp.crestwood.on.ca/…",
    "media_url": null,
    "theme_tags": ["Auschwitz", "Hidden Child"],
    "waypoints": [
      {
        "as_written": "Lemberg",
        "canonical": "Lviv, Ukraine",
        "role": "birthplace",      // birthplace | ghetto | camp | transit | liberation | resettlement
        "lat": 49.84, "lng": 24.03,
        "date": { "start": "1925", "end": "1925", "precision": "year" },
        "confidence": 0.92,
        "verified": true
      }
      // … ordered list = the journey
    ]
  }
}
```

Plus two derived artifacts emitted by the same build:
- `place_index.json` — `canonical place → [survivor_id]` for instant place clicks.
- `connections.json` — verified `{place, survivorA, survivorB, overlap_window}` for
  the connection layer.

A **`geocode_cache.json`** is committed to the repo so rebuilds don't re-hit the
geocoder and results stay stable.

---

## 5. Risk register

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Custom post type not exposed in REST API | Medium | High | Confirm `/wp-json/wp/v2/types` first; HTML-scrape fallback ready |
| R2 | Wrong/empty geocodes from historical names | High | High | Normalization layer + GeoNames alternateNames + human review |
| R3 | Publishing an unverified/false fact about a real person | Medium | Severe | Mandatory human-review gate before publish; show uncertainty |
| R4 | 200+ markers lag on mobile | Medium | Medium | Marker clustering; precomputed data; test on a real phone |
| R5 | Scope creep (you try to build all modes at once) | High | High | Walking-skeleton first; each mode is a separate milestone |
| R6 | Permission/sensitivity issue | Low | Severe | Written sign-off before any ingest; aggregate-exposure check |
| R7 | LLM hallucinates places not in the text | Medium | High | Cross-check every extracted place against source text; gazetteer |
| R8 | You burn out mid-project | Medium | High | Ship the MVP early; everything after is additive, never blocking |

Risk R3/R7 are the ones that matter most. The whole pipeline is built around a
human confirming facts before they go live.

---

## 6. Phased milestones

Each milestone is independently demoable. Stop at any point and you still have
something real.

### Phase 0 — Discovery & permission (½ week)
- Confirm REST API: open `/wp-json/wp/v2/types` and `/wp-json/wp/v2/ohp-type`.
- Get Mr. Masters' written OK and a sensitivity check.
- Pick 5 "anchor" survivors with rich, clear testimonies for early dev.
- **Deliverable:** a one-page findings note (API or scrape? fields available?) and
  permission on record.
- **Done when:** you know exactly how data comes out and you're cleared to use it.

### Phase 1 — Walking skeleton (1 week)
- Hand-write the 5 anchor survivors into `survivors.geojson` by reading their pages.
- Build the Explore map: Positron basemap, 5 dots, click → side panel, journey line.
- Deploy to GitHub Pages immediately (deploy on day one, not at the end).
- **Deliverable:** a live URL with 5 real survivors, fully clickable.
- **Done when:** F4, F5 work end-to-end on 5 records, on a phone.

*Why hand-write the data first: it de-risks the front end before you touch the hard
NLP/geocoding work, and it forces you to finalize the schema against real content.*

### Phase 2 — Ingest + extract pipeline (2 weeks)
- Build the Python ingest (Plan A REST, Plan B scrape behind one interface).
- LLM structured-extraction step → journeys as JSON.
- Gazetteer/rule validation + JSON-schema validation.
- Human-review gate: a simple checklist/CSV you tick off, or a tiny review page.
- **Deliverable:** `survivors.geojson` generated for all 200+ (reviewed in batches).
- **Done when:** F1–F3 produce schema-valid, reviewed data for the full archive.

### Phase 3 — Geocoding + place features (1 week)
- Normalization table + GeoNames lookup + cached geocode.
- `place_index.json`; wire up click-a-place → highlight all connected survivors.
- Filter bar (F7).
- **Deliverable:** full map with real coordinates, place clicks, and filtering.
- **Done when:** F6, F7 work and pins land in the right cities.

### Phase 4 — Narrative & patterns (2 weeks)
- Scrollytelling guided intro with Scrollama (F8).
- Patterns mode: flow lines + origin density (F9).
- `connections.json` + the connection layer (the verified overlaps).
- Time scrubber (F10).
- **Deliverable:** all three modes + scrubber live.
- **Done when:** F8–F10 work and at least one verified connection is surfaced.

### Phase 5 — Automation + polish (1 week)
- CI pipeline: scheduled rebuild + manual trigger (+ optional WP webhook) (F12).
- Deep links (F11), accessibility pass, mobile pass, reduced-motion.
- The one-line embed for Mr. Masters.
- **Deliverable:** hands-off auto-updating site + handoff README.
- **Done when:** publishing a test entry in WordPress makes it appear automatically.

---

## 7. Testing strategy

- **Unit tests (pytest):** name normalization (Lemberg→Lviv), date parsing,
  waypoint ordering, index building.
- **Data validation (in CI):** every record validated against a JSON Schema; build
  *fails* if any record is malformed. This is your safety net — bad data can't deploy.
- **Extraction spot-checks:** keep a small "golden set" of ~10 testimonies you've
  hand-annotated; measure the LLM pipeline against them each time you change the prompt.
- **Visual/manual:** click every mode; test on a real phone, not just devtools.
- **Accessibility:** keyboard-only run-through; a screen reader (VoiceOver/NVDA);
  contrast checker; `prefers-reduced-motion` on.
- **User acceptance:** Mr. Masters reviews a sample of journeys for factual
  accuracy *before* launch. His sign-off is the real acceptance test.

---

## 8. Deployment & CI/CD

- **Repo:** one GitHub repo. Pipeline in `/pipeline`, site in `/site`, data in `/data`.
- **CI:** GitHub Actions.
  - `on: schedule` (e.g. weekly cron) — the baseline auto-update.
  - `on: workflow_dispatch` — manual "rebuild now" button.
  - optional `on: repository_dispatch` — fired by a WordPress webhook on publish for
    near-real-time updates.
  - Job: run pipeline → validate → commit changed JSON → deploy.
- **Hosting:** GitHub Pages, Netlify, or Cloudflare Pages — all free for static sites.
- **Secrets:** the LLM API key lives in GitHub Actions secrets, never in the repo.
- **Embed:** a single `<iframe src="…">` (or one script tag) on the OHP homepage.

---

## 9. Maintenance plan

- The scheduled CI job means the map keeps updating with no human action.
- The geocode cache and golden set are committed, so the project is reproducible
  years later by someone who isn't you.
- The handoff README documents how to run the pipeline, where the review gate is,
  and how to add a new OHP category — so the next student can take it over.

---

## 10. Realistic timeline

~**8–10 weeks part-time** (a few focused evenings + weekend blocks per week).
Phases 1, 2, and 4 are the heavy ones. The schedule is deliberately front-loaded
so you have a live, demoable site by end of week 2 — useful if a college deadline
arrives before the project is "finished." There is no phase whose absence breaks an
earlier phase, so you can stop after any milestone and still have something real.

---

## 11. Definition of Done (v1)

- All 200+ survivors on the map with reviewed, schema-valid data.
- Guided, Explore, and Patterns modes + time scrubber all working on mobile.
- At least one verified "same place, same time" connection surfaced.
- Accessibility pass complete; reduced-motion honored.
- Auto-rebuild proven by publishing a test entry.
- Mr. Masters has signed off on factual accuracy and embedded it.
