# 03 — Tools, Skills & Resources

Everything you'll touch, *why* it's the right choice, the skills to build, and free
places to learn them. Choices favor: free, well-documented, industry-standard, and
appropriate to the scale (200 docs, static site, solo dev).

---

## The stack at a glance

| Layer | Choice | Why this one |
|-------|--------|--------------|
| Ingest | Python + `requests` | WordPress REST API returns JSON; `requests` is the standard client |
| Scrape fallback | `beautifulsoup4` + `lxml` | Only if the REST API isn't exposed |
| Extraction | An LLM via API (Claude/GPT), prompted for JSON | Best on rare/out-of-domain entities; returns structured journeys in one pass |
| Validation | `pydantic` or `jsonschema` + a camp/ghetto gazetteer | Deterministic backstop around the probabilistic extractor |
| Geocoding | GeoNames `alternateNames` dump (local) or Nominatim (cached) | Solves historical exonyms; local = no rate limits |
| Map | Leaflet.js | Smallest, best-documented map lib; huge plugin ecosystem |
| Basemap | CARTO Positron tiles | Desaturated, built to sit under data; museum tone for free |
| Clustering | Leaflet.markercluster | Keeps 200+ markers smooth on mobile |
| Scrollytelling | Scrollama | The standard scroll-trigger lib; built on IntersectionObserver |
| Graph (optional) | d3-force or Cytoscape.js | The non-geographic connection view |
| Version control | Git + GitHub | Non-negotiable industry baseline |
| CI/CD | GitHub Actions | Free, runs your rebuild on schedule/trigger |
| Hosting | GitHub Pages / Netlify / Cloudflare Pages | Free static hosting |
| Build agent | Claude Code | Drives the build from the prompt in `04_build_prompt.md` |

**Upgrade path (don't start here):** swap Leaflet for **MapLibre GL** + vector
tiles when you want to restyle every map layer yourself. There's an open Positron
GL style to fork. Do this only after v1 works.

### Visual upgrade libraries (use with restraint — see doc 08 first)

These power the "beautiful" layer. Each is enhancement on top of an accessible 2D
baseline, never a replacement for it.

| Tool | Use | Note |
|------|-----|------|
| MapLibre GL globe projection | A slow globe "establishing shot" of the journeys | Overview only; settles into 2D |
| deck.gl `ArcLayer` | Raised arcs linking origin → destination across Europe | Conveys scale of displacement; one muted accent |
| deck.gl `GlobeView` | 3D globe overview of all journeys | Experimental; no high-zoom detail |
| David Rumsey georeferenced maps | Faint period-accurate 1930s–40s Europe overlay | The tasteful "WW2 era" look; https://www.davidrumsey.com/view/georeferencer |

deck.gl interleaves with MapLibre via `MapboxOverlay` (needs WebGL2 / maplibre-gl
≥ 3). Reach for this stack only if the gentle-3D overview genuinely adds meaning;
for most of the site, Leaflet + Positron is the right tool.

**Portrait/photo handling:** if you show survivor faces, you need the *rights* to
each one (see doc 08, weakness #2). Treat photos as cleared-per-person assets, store
the permission status alongside each, and present them as dignified portraits with
name + dates — never a decorative collage.

---

## Why an LLM for extraction instead of "just spaCy"

- Holocaust toponyms are rare, multilingual, and historically renamed — exactly the
  out-of-domain case where general NER models under-recall and LLMs do better.
- You want **structured output** (place + role + date + order), not just tagged
  spans. An LLM returns that as JSON in one call; benchmarks put structured-JSON
  LLM extraction around 0.93 F1.
- The corpus is tiny, so the usual "LLMs are too slow/expensive at scale" objection
  doesn't apply.
- **But** LLMs over-extract and sometimes mislabel entity *type*, so you keep a
  gazetteer + a rule check + human review. `spacy-llm` is a clean way to run the LLM
  *inside* a spaCy pipeline if you want one framework. Classic `spaCy` + an
  `EntityRuler` gazetteer is still a fine deterministic second opinion.

---

## Skills to build, mapped to the project

You don't need to master these in the abstract — each maps to a concrete part you'll
build. Learn them just-in-time, in this order.

1. **Python fundamentals + HTTP/JSON** → the ingest layer. (requests, dicts, files.)
2. **Reading API docs** → discovering the WordPress REST endpoints and pagination.
3. **Prompt engineering for structured output** → the extraction step. (Asking a
   model for strict JSON, giving few-shot examples, validating what comes back.)
4. **Data modeling / JSON Schema** → the `survivors.geojson` schema + validation.
5. **Geospatial basics** → lat/lng, GeoJSON, geocoding, why coordinate order is
   `[lng, lat]` in GeoJSON (a classic bug source).
6. **JavaScript + the DOM** → the front end and side panel.
7. **Leaflet** → markers, layers, popups, polylines, events.
8. **CSS layout + responsive design** → the panel, filter bar, mobile.
9. **Scrollama / IntersectionObserver** → the guided mode.
10. **Git + GitHub Actions** → version control and the auto-update pipeline.
11. **Accessibility (a11y) basics** → ARIA labels, keyboard nav, contrast, reduced motion.
12. **Testing basics (pytest)** → unit tests for normalization and the golden set.

For an ECE/CS/AI applicant, the standout skills here are 3 (applied LLM
engineering), 4–5 (data modeling/geospatial), and 10 (CI/CD) — those are the ones
that read as "this person builds real systems," not just "this person can code."

---

## Free learning resources

**Mapping**
- Leaflet quick-start & tutorials — https://leafletjs.com/examples.html
- Leaflet.markercluster — https://github.com/Leaflet/Leaflet.markercluster
- CARTO basemap styles (URLs + names) — https://github.com/cartodb/basemap-styles
- Positron GL style (for the MapLibre upgrade) — https://github.com/openmaptiles/positron-gl-style
- Free basemap sources overview — https://openmaptiles.org/styles/

**Scrollytelling**
- Scrollama — https://github.com/russellsamora/scrollama
- "What great scrollytelling looks like" (Flourish) — https://flourish.studio/blog/scrollytelling-examples/
- Scrollama + CSS walkthrough — https://metadrop.net/en/articles/scrollytelling-using-scrollamajs-css-and-best-practices

**NLP / LLM extraction**
- spaCy course (free) — https://course.spacy.io
- spacy-llm (LLMs inside spaCy) — https://github.com/explosion/spacy-llm
- spaCy EntityRuler (gazetteer matching) — https://spacy.io/usage/rule-based-matching

**Geocoding / historical place names**
- GeoNames (download `alternateNames`) — https://www.geonames.org/ / https://download.geonames.org/export/dump/
- Nominatim usage policy (rate limits) — https://operations.osmfoundation.org/policies/nominatim/
- JewishGen Communities Database / Galician gazetteer — https://lvov.us/galician-genealogy/cities-and-towns/
- USHMM geographic name expansion (reference) — https://collections.ushmm.org/search/help

**WordPress as a data source**
- WP REST API handbook — https://developer.wordpress.org/rest-api/
- Headless WP + static rebuild patterns — https://pantheon.io/learning-center/headless/wordpress-api-examples

**Web fundamentals / a11y / CI**
- MDN Web Docs — https://developer.mozilla.org/
- WebAIM (accessibility) — https://webaim.org/
- GitHub Actions docs — https://docs.github.com/actions

**Precedents to study (from the prior research)**
- Through Hell to the Midwest (ArcGIS, closest analog) — https://storymaps.arcgis.com/collections/789e81f7d229409a8b871deab007511a
- Yad Vashem Auschwitz testimony map — https://www.yadvashem.org/education/educational-materials/lesson-plans/auschwitz-map.html
- Remember.org "The Last Sunrise" (single-journey UX) — https://remember.org/harold/map
- NC Council on the Holocaust survivor map — https://ncholocaustcouncilworkshops.org/3d-flip-book/interactive-survivor-map/
- USC Shoah "Dimensions in Testimony" (NLP + testimony) — https://en.wikipedia.org/wiki/Dimensions_in_Testimony

---

## Anthropic tools you can actually use on this

- **Claude Code** — point it at an empty repo and feed it `04_build_prompt.md` to
  scaffold and build phase by phase. It can run the Python, write the front end, and
  set up the GitHub Action.
- **The Claude API** — this is the LLM that does the extraction step. For ~200
  testimonies, use a Sonnet-class model (strong at structured JSON, cheap at this
  volume); reserve a more powerful model for the few hardest testimonies. Always
  validate the JSON it returns against your schema before trusting it.

(For current model names, pricing, and limits, check the official docs rather than
relying on any single snapshot: https://docs.claude.com)
