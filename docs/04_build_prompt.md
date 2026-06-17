# 04 — Build Prompt (copy-paste into Claude Code)

How to use this: open an empty folder, start **Claude Code** in it, and paste the
block below. It's written so the agent builds in the same phased order as the SDLC
plan, checking in with you between phases instead of dumping everything at once.

Replace the three `<…>` placeholders at the top before pasting. Don't skip the
permission/verification guardrails — they're load-bearing, not boilerplate.

---

```text
You are helping me build an interactive web map of Holocaust survivor journeys from
the Crestwood Oral History Project (OHP). Build it phase by phase. STOP at the end
of each phase, show me what you did, and wait for my go-ahead before the next phase.

# CONTEXT
- Data source: the OHP archive at https://ohp.crestwood.on.ca — it runs WordPress
  6.9.4 with a custom post type under an "ohp-type" taxonomy term "Holocaust
  Survivors". Prefer the WordPress REST API (/wp-json/wp/v2/...) over HTML scraping.
- Source of truth stays in WordPress. We only READ. Never write back.
- Final output is a STATIC site (precomputed JSON + Leaflet). No server at runtime.
- This is real Holocaust testimony about real people. Accuracy and restraint matter
  more than features. When unsure, surface uncertainty instead of guessing.

# MY INPUTS
- LLM API key for the extraction step: <I will provide via env var, never hardcode>
- Permission status: <confirm you have Mr. Masters' written OK before any ingest>
- Anchor survivors for early dev (5 slugs/URLs): <paste 5 here>

# TECH STACK (use exactly this unless you flag a concrete reason to change)
- Pipeline: Python 3, `requests`; `beautifulsoup4`+`lxml` only as scrape fallback.
- Extraction: call the LLM API, prompt for STRICT JSON, then validate.
- Validation: `pydantic` (or `jsonschema`) + a curated camp/ghetto gazetteer.
- Geocoding: GeoNames alternateNames locally if feasible, else Nominatim with a
  committed cache and 1 req/sec throttle. Geocode at BUILD time only; cache results.
- Front end: vanilla JS + Leaflet.js. Basemap: CARTO Positron
  (https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png, with attribution).
  Leaflet.markercluster for the markers. Scrollama for the guided intro.
- Repo layout: /pipeline (Python), /site (static front end), /data (generated JSON),
  /data/geocode_cache.json (committed), /data/golden (hand-checked test cases).
- CI: GitHub Actions. Hosting target: GitHub Pages.

# DATA SCHEMA (survivors.geojson — FeatureCollection, one Feature per survivor)
Point geometry at the hometown. properties:
  survivor_id, name, bio_excerpt, archive_url, media_url, theme_tags[],
  waypoints[]: { as_written, canonical, role, lat, lng,
                 date:{start,end,precision}, confidence, verified }
  role ∈ {birthplace, ghetto, camp, transit, liberation, resettlement}
Also emit: place_index.json (canonical place -> [survivor_id]) and
connections.json (verified {place, survivorA, survivorB, overlap_window}).
Validate EVERY record against the schema; the build must FAIL on invalid data.
Remember GeoJSON coordinate order is [lng, lat].

# HARD GUARDRAILS (do not violate)
1. Do not ingest anything until I confirm permission is in place.
2. Never publish an extracted place/date/connection without a human-review step.
   Build a simple review gate: emit a CSV/JSON of low-confidence or
   unverified items for me to approve; only verified=true records render.
3. Never assert two real people were together unless the overlap is verified
   against both testimonies. Represent fuzzy dates as ranges, never fake precision.
4. Preserve each survivor's original ("as_written") place name alongside canonical.
5. No secrets in the repo. API keys come from env vars / GitHub Actions secrets.
6. Accessibility is a requirement: keyboard nav, ARIA labels on markers/panel,
   AA contrast, and honor prefers-reduced-motion. No bouncing/auto-playing motion.
7. Restraint over spectacle. This is a memorial, not a game. No 3D reconstructions
   of camps, no AR, no dramatic "war" styling, no decorative collages of faces. Any
   3D (e.g. a globe overview or journey arcs) is an enhancement on top of a fully
   working, accessible 2D map, which is the canonical product and fallback.
8. Show only photos/quotes we have rights to. Default to paraphrase + short excerpts
   + a link to the full archive entry rather than republishing testimony text;
   present any portrait dignified, one at a time, with name and dates.

# PHASES (stop after each; show me a working result)

PHASE 0 — Discovery
- Probe /wp-json/wp/v2/types and /wp-json/wp/v2/ohp-type. Report whether the REST
  API exposes the survivor post type, what fields are available, and how it
  paginates. If not exposed, propose the scrape fallback. Output a short findings
  note. Do NOT mass-ingest yet.

PHASE 1 — Walking skeleton (front end first, fake data)
- I'll hand you 5 anchor survivors. Put them in survivors.geojson by the schema.
- Build the Explore map: Positron basemap, 5 dots, click a dot -> side panel with
  bio, archive link, as-written place names, and a journey polyline.
- Make it responsive and keyboard-accessible. Add a GitHub Pages deploy now.
- Deliver a live URL working on mobile with the 5 records.

PHASE 2 — Ingest + extraction pipeline
- Build ingest (REST primary, scrape fallback) behind one interface.
- LLM extraction -> structured journeys as JSON. Cross-check every extracted place
  against the source text; drop anything not supported. Gazetteer-validate known
  camps/ghettos. Schema-validate. Emit the human-review queue.
- Run it on the full archive in batches. Don't mark anything verified automatically.

PHASE 3 — Geocoding + place features
- Normalization table (historical exonyms -> canonical) + geocode + commit cache.
- Build place_index.json; wire click-a-place -> highlight/list connected survivors.
- Add the filter bar (camp, origin country, theme tag, free text).

PHASE 4 — Narrative + patterns
- Guided scrollytelling intro for ONE survivor (Scrollama drives map pan/zoom/draw).
- Patterns mode: flow lines + origin density layer.
- connections.json + the connection layer (verified overlaps only).
- Time scrubber (~1933–1950) animating dot positions along journeys; fuzzy dates
  shown as soft/range presence, not points.

PHASE 5 — Automation + polish
- GitHub Actions: scheduled rebuild + manual workflow_dispatch (+ optional
  repository_dispatch for a WordPress publish webhook). Job runs pipeline ->
  validates -> commits changed JSON -> deploys. Build fails on invalid data.
- Deep links (#/survivor/<id>, #/place/<id>). Final a11y + mobile pass.
- Produce a one-line <iframe> embed snippet and a handoff README documenting how to
  run the pipeline, where the review gate is, and how to add a new OHP category.

# WORKING STYLE
- Clean, commented code I can learn from. Explain WHY for non-obvious design
  choices. Point out bugs/edge cases beyond what I asked. Use proper terminology.
- Prefer Python for the pipeline, JavaScript for the web. Write tests for name
  normalization, date parsing, and waypoint ordering, plus a golden-set check for
  extraction quality.
- Keep commits small and described. Update the README as you go.
```

---

## Tips for running it

- **Run it in Claude Code**, not a chat box — it needs to create files, run the
  Python, and set up the Action across many turns.
- **Go phase by phase.** When it stops, actually test the live URL before saying
  "continue." The whole point of the phased prompt is that you never end up with a
  pile of untested code.
- **You are the review gate.** When Phase 2 hands you the low-confidence queue, sit
  with the testimonies and check them. This is the slow, human, important part — and
  it's also where you'll find the connection that becomes your essay.
- **Keep the golden set honest.** Hand-annotate ~10 testimonies yourself first;
  that's your ground truth for judging whether a prompt change actually helped.
