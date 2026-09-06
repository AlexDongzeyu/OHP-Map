# Crestwood OHP — Journeys

An interactive memorial map of the whole **Crestwood Oral History Project**
(`ohp.crestwood.on.ca`) — the life journeys of **Holocaust survivors, war veterans,
community members, and others** whom Crestwood students have interviewed. **Explore**
brings each person's account, photographs, interview chapters, and recorded places
together. **History** shows dated territories from 1914 to 2026, documented flags,
wartime alignment, recorded accounts, and mapped route origins.

**Live data:** the map is populated with **real people across the archive's
categories**, scraped from the public OHP listings and auto-extracted from each public
bio, then drawn on a quiet **world map** (D3 + TopoJSON) that spans Europe, Canada, and
the Pacific. **Live site:** https://ohpmap.alexdong0414.workers.dev/

A first-time visitor lands on a slowly rotating globe and enters the collection through
**Explore**. Accounts follow the archive's own categories and alphabetical ordering.
There is no separate Guided page; its old URL redirects to Explore.

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

Search for a person or place in Explore, filter by community, and open an account.
The profile includes a readable summary, source photographs where available, genuine
interview-chapter links, and complete source passages beside mapped places. Selecting a
place focuses the map without opening another page. Public profiles without mapped places
remain readable in the collection rather than receiving invented coordinates. History
supports country/place search, dated administration details and flags, layer controls,
historical/current comparison, year playback, and shareable views. WordPress remains
the source; the Cloudflare Worker keeps the public inventory current.

Community checkboxes include or exclude only the named group. **Select all**, **Clear
selection**, and **Reset filters** are explicit actions. Searches match names, current
place names, and source spellings. A country in **Route origins** opens its exact account
cohort, not every biography that mentions that country; those filters can be shared in
an Explore URL.

Collection markers group the accounts naming each place. Arrow keys move between
markers or loaded account rows without adding thousands of tab stops. **Skip to map**
and **Skip to account** bypass the collection. A selected account frames all its mapped
references; this does not turn uncertain mentions into a personal route. Solid, hollow
and dashed marks distinguish precise person-linked references, broad areas and mentions
needing review. Both maps include a key, and the reader reconciles these categories in
one place-count summary. **Full map** reveals more map space without losing the account.
Nearby count labels appear as space becomes available when zooming; every place
remains reachable with the keyboard even when its number is not shown.
**Browse places** opens a searchable place-name index, including original spellings.
Its counts respect the current search, communities and reading-list scope, and count
people rather than repeated mentions. Choosing a place replaces the previous place
filter; it does not turn a source mention into verified personal presence.

Misspelled searches offer explicit suggestions rather than silently changing the query.
History settings provide 1x, 2x and 4x playback. Route-origin shading uses a square-root
scale so small cohorts remain visible; its explanation identifies the Toronto-school
collection bias rather than presenting the archive as a population sample. Nazi-era
Germany uses a neutral text identifier instead of a decorative swastika.

Each account has persistent navigation to its text, photographs, interview chapters,
and places. The map shows only that selected account, labels current versus historical
borders, and explains when there is not enough evidence to draw a route. A chapter link
to OHP is not a guarantee of available playback.

Historical search asks visitors to choose between ambiguous results. If the dated
geometry fails to load, a visible notice identifies the neutral, present-day basemap and
offers a retry without resetting the year or layers. About and the year-context sources
include a readable boundary-audit summary, with the underlying report labelled as a
technical JSON download.

On a short screen, Explore gives the account list and reader the available height
instead of leaving them below a fixed map. **Map** and **Read** controls switch between
the two without discarding the reader's scroll position. On portrait phones, the reader
can also be expanded. Compact History context opens as a readable sheet with a clear
return to the map.

Every dated place is available in the History browse list, including references omitted
from the map to avoid crowded markers. Selecting one opens and focuses its account
details. Selected history routes use only city/site references dated to that year;
an account's undated or other-year references remain in Explore, not on that year map.
Account-map markers also open their matching source entries. Broken account and place
links show an explanation and recovery actions rather than silently returning home.

Collection addresses retain the search, selected communities, origin filter, and loaded
result count. Account links opened from that collection retain the same browsing context
after a reload. Historical map links retain the selected dated place as well as the
year and layers, so sharing a view or returning from an account restores its context.
Unsupported community filters and dated-place/year combinations receive an explicit
link-recovery view instead of silently changing the selection.
Browser tab and bookmark titles identify the account, search, or historical place/year.

Selecting a recorded place now keeps a source-bound reference in the account's view
address. **Copy reference link** creates a clean link to that exact source entry
without private saved-list or search filters. The link uses the same fingerprint
contract as human review, not the waypoint's array position. Reordering does not
change the target; changed or ambiguous evidence produces a readable recovery notice
instead of focusing the wrong place. A mention moved into retained source context
opens there without being promoted back into a personal route.

**Continue through shared places** offers up to three other accounts within the
current results, with the shared city/site names shown explicitly. Country-level
references and contextual-only mentions do not drive the suggestions. These are
connections between source mentions, not claims of shared travel, contact or meetings.
The account's name remains visible in the reader toolbar when arriving at a deep
reference or reading farther down the page.

### Keeping and citing accounts

Use the bookmark beside a name or **Save account** in the reader to build a private
reading list. **Saved** in the collection opens that browser's list; search and community
filters also work there. Saved IDs stay in local storage, not on the server, and update
across tabs. A saved-view URL refers to the receiving browser's own list, not the sender's.
Blocked storage is reported without pretending a save succeeded. Clearing the list
requires confirmation and does not change the public archive.

**Filters → Captioned chapters** narrows the collection using recorded caption
metadata. The filter works with search, communities, places and saved/shared lists,
and survives account navigation and shared view URLs. Counts refer to accounts,
not individual caption tracks. A listed caption is not a guarantee that a provider
will allow current playback or access; those limitations remain visible.

In **Saved**, **Share list** creates an explicit link containing the public IDs of
all accounts matching the current filters, not just the loaded page. Other saved
accounts are excluded. A recipient opens a **Shared reading list**, can search or
filter within that selection, and can choose **Save accounts** to merge the available
results into their own list without replacing it. Opening the link alone writes
nothing to browser storage. Missing accounts remain identified as unavailable rather
than silently disappearing from the link. Oversized links give a clear recovery
message instead of truncating the selection.

**Download citations** creates a portable text file of original OHP source citations
with an access date. It works for larger selections without loading each biography
or media inventory. These are source-page citations, not downloaded transcripts or
human verification of the mapped claims.

**Print** in a loaded account prepares a reading sheet instead of printing the
clipped application panels. It includes the public summary, source citation, source
spellings, qualified place references and retained context. **Print list** inside
the sharing dialog prints its exact selected citations. Use the browser's print
dialog to print on paper or save a PDF. These sheets are not interview transcripts.
The native browser print command also supports an open account or saved/shared
reading list. Unloaded details are labelled incomplete, and server-readable profile
pages remain printable without JavaScript.

**Share & cite** supplies a clean account link and a plain-text citation for the original
OHP page, including an access date. It does not invent interview dates or claim that a
summary is a transcript. Both fields remain selectable when clipboard access is denied.
**Previous** and **Next** follow the same community/surname order as the filtered
collection, including saved accounts; browsing onward loads further results when needed.

### Reviewing source claims

The loaded reader's **Review these references** section downloads an unchanged,
single-account source package. A trusted project maintainer can turn it into a review
worksheet, have a student or teacher check the original interview, then validate and
apply the attributed decisions:

```powershell
python -m pipeline.review_decisions export --dataset adam-wally-review-source.json --survivor-id adam-wally --output worksheet.json
python -m pipeline.review_decisions check --dataset data\survivors.geojson --decisions decisions.json
python -m pipeline.review_decisions apply --dataset data\survivors.geojson --decisions decisions.json --output reviewed-candidate.geojson
python -m pipeline.build --source all --review-decisions decisions.json
```

Keep the completed decision file in version control and supply it on subsequent builds.
Every decision requires a reviewer, date, evidence URL, rationale, and source fingerprint.
Changed source text or coordinates invalidate an old approval. Approvals do not inflate
pipeline confidence values, and rejected/contextual mentions remain available as source
context rather than being erased. Partial approvals do not verify the whole account.
Reviewer names and rationales are public audit information; contributors must know that
before submitting a decision. There is no unauthenticated approval endpoint and no real
claims were automatically verified by adding this workflow.

The landing page's rotating globe and moving portrait belts play automatically while
the page is visible, with no start/pause control or motion URL setting. They pause in
hidden tabs and resume when the visitor returns. The rest of the interface continues
to respect reduced motion: counters and route drawing settle to their final state,
and ongoing history playback stops. Escape closes an open interview player before
leaving its account, returning keyboard focus to the selected chapter.

Collection and atlas searches fold source spellings such as Lodz / Łódź consistently.
Collection search text is prepared once when loading the archive. The dated-place list
shows the recorded role to distinguish separate entries at the same location, and
committing an out-of-range whole year selects the nearest supported year. These controls
do not merge source claims, assign verification, or change historical flag policy.

Initial data requests retry once after a transport interruption or a temporary
502/503/504 response. The loading screen announces reconnection; a second failure,
invalid JSON, or a non-transient response still reaches the normal recovery screen.
Short `Retry-After` delays are respected; longer outages are surfaced rather than
keeping the visitor in an indefinite retry loop.

The Worker streams a validated KV publication instead of parsing the full archive
on each HTTP request. The hourly sync attaches revision metadata atomically to its
normal data write, without duplicating the dataset on every refresh. A separately
validated, versioned snapshot bridges older caches that do not yet have this metadata.
Conditional requests use an ETag so unchanged archives need not be downloaded again.
If no matching publication exists, the Worker identifies its bundled-archive fallback
through the response header and logs the condition. Dataset migrations remain in the
publishing workflow, outside the request CPU budget.
The cron queues a single SQLite-backed Durable Object alarm for the existing refresh
job. This keeps scraping, JSON processing and migration out of the Free plan's 10 ms
Worker/Cron budget; Durable Objects provide a 30-second CPU budget without a plan
upgrade. Queue deduplication prevents overlapping refreshes. A compatibility snapshot
can request one background preparation after deployment without delaying page loading.

### Compact delivery and discoverable accounts

Startup uses `/data/index.json`, a compact map and search index, instead of transferring
every biography and media inventory. Opening an account fetches its complete original
feature from a content-addressed `/data/profiles/{id}.{sha256}.json` URL. Failed details
offer a retry; a mismatched version asks the visitor to reload the collection rather
than silently mixing evidence. The full `/data/survivors.geojson` endpoint remains
available for research and compatibility.

The build publishes real `/survivor/{id}` pages with server-readable source summaries,
individual titles, canonical URLs and social-preview metadata. `/sitemap.xml` lists
the public accounts. Old hash links still open correctly. The Worker handles aliases
and genuine HTTP 404s; a plain file server cannot reproduce these routes.
If the profile catalog reaches an edge before its updated collection index, the
valid source page remains readable with a retry action instead of becoming a false 404.
Share metadata uses the licensed full-size source photograph where available, not
the 192px reader thumbnail. Accounts without a permitted original use the branded
1200x630 PNG fallback rather than an unsupported SVG preview.

Live refresh stages immutable detail files before switching the compact index. It
reuses unchanged files and limits changed-detail KV writes to 30 per hourly refresh,
keeping the previous complete publication usable while a larger update is staged.
Source-bound human decisions survive refresh only while their evidence still matches.
Pending updates are bound to the deployed seed version. A new seed reconciles review
decisions before staging resumes, so an older in-progress snapshot cannot restore a
rejected reference or discard a newly imported decision.

Static scripts, styles, fonts, portraits and flags are served from a content-hashed
`/releases/{sha256}/` tree with one-year immutable caching. Stable aliases revalidate;
data stays under `/data/`. The current and one preceding verified static release are
retained within the asset limit. Responses add a compatible CSP, `nosniff`, referrer
and permissions policies; Vimeo playback and legitimate Crestwood embedding remain
allowed. These changes do not assert that search engines have already indexed a page.

Production assembly uses `--restore-published` to restore and verify the actually
published preceding release, including on a clean CI checkout. Its manifest and file
hashes must agree; a required restore failure stops the build. The first versioned
deployment may proceed after confirming that the live site is still unversioned.
`OHP_PUBLISHED_ORIGIN` overrides the public origin used for this read-only restore.
Unflagged assembly remains available for offline static previews.

---

## Local preview

```powershell
# Assemble the committed archive and serve the actual Worker routes locally.
npx wrangler dev --local --ip 127.0.0.1 --port 8124
# Open http://127.0.0.1:8124
```

Open the URL, browse an account in Explore, or choose a year in History. Marker
counts refer to accounts naming a place, not a claim that those people met there.
This uses local KV and Durable Object storage, not the live archive's storage.
A static-only visual preview can instead run `node tools\assemble_site.cjs` followed
by `python -m http.server 8124 --directory public`, but must use the legacy hash
routes and cannot validate profile HTTP responses, security headers or redirects.

To regenerate the source dataset offline, install the existing Python requirements
and run `python -m pipeline.build --source all`. Preserve and replay any real human
decision files as described above; do not replace them with automatic approvals.

Other builds:

```bash
python -m pipeline.scrape_ohp --refresh   # re-pull all pages from the live archive
python -m pipeline.build --source local   # the fictional fixture set (used by tests)
python -m pipeline.build --strict         # publish only human-reviewed records
python -m pipeline.build --discover       # probe the WP REST API and exit
```

Run the tests with `python -m pytest -q`. A headless browser smoke test is in
`tools/smoke.cjs` (`node tools\smoke.cjs http://127.0.0.1:8124` against a running
Worker preview; puppeteer-core + Edge). The complete smoke suite requires Worker
routing, not only a static file server.
`python tools\source_print_smoke.py --base http://127.0.0.1:8124` verifies actual
multi-page account/list PDFs with the existing Playwright and pypdf setup. Pass
`--output` to keep the PDFs for visual inspection; otherwise temporary output is
removed automatically.

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
│  D3 + TopoJSON vector atlas of Europe          │
│  Explore / History + media and year controls  │
└───────────────────────────────────────────────┘
        │  GitHub Actions (CI)  ─and─  Cloudflare Worker (deploy + cron + KV)
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

Vanilla ES modules, no bundler. Libraries are **vendored and pinned** in `vendor/` (no
fragile CDNs). D3 owns the cartography while GSAP owns the restrained interface
orchestration. The Equal Earth world map remains mounted as the visitor moves between
the collection and historical atlas. Routes use one continuous curve, and the camera fits
the visible area around the reading and context panels. The landing page uses an
orthographic globe.

| File | Responsibility |
|------|----------------|
| `js/config.js` | The restrained palette, role vocabulary, time range, helpers |
| `js/data.js` | Loads profile, place and historical metadata into the journey and media models |
| `js/atlas.js` | Projections, continuous routes, camera, territory inspection, dated flags and historical/current comparison |
| `js/ui.js` | Collection profiles, media, historical controls and source panels |
| `js/media.js` | Trusted media URLs, public Vimeo embed references and caption-status wording |
| `js/historical-context.js` | Dated flag assets, per-file source/rights records and historical context links |
| `js/motion.js` | Reduced-motion-aware GSAP orchestration |
| `js/app.js` | View switching, media playback, place focus, historical navigation and sharing |
| `tools/build_atlas.cjs` | Build step: trims the vendored world-atlas TopoJSON to a compact ~51 KB Europe GeoJSON (`data/atlas-europe.json`) |

**Deep links:** `#/explore`, `#/patterns/<year>`, `#/about`, `#/survivor/<id>`,
`#/place/<slug>`. Historical links can retain a controller, layer choices, opacity,
comparison split, and map position. Legacy `#/guided` links redirect to Explore.

**Visual craft:** the archive reading-room design pairs mineral paper, dark blue-green
binding ink, Spectral names and reading text, and Public Sans controls. Real photographs
provide the archival character without sepia filters, imitation stamps, or repeated glass
cards. Landing is an album cover; Explore combines a collection index with source material;
History is a dated atlas; About includes a collection ledger and
source list. Fonts and GSAP remain self-hosted.

Explore has expandable community filters, a recoverable empty-search state, and profile
actions beside the account's identity. Closing a profile restores the collection's scroll
position and keyboard focus. Profiles use ordinary document spacing, not tall scrolling
chapters. Photographs and interview lists appear alongside the account; video players load
only after a chapter is selected. Complete place passages retain their source wording.
The map fits the exposed area beside desktop panels or above mobile sheets. History opens
at 1944 and keeps its year, territories, flags, and accounts synchronized. Its mobile context
panel folds away to leave room for the map. Route-origin counts describe mapped starting
places rather than asserting that inferred locations are confirmed birthplaces. Explore
uses today's neutral basemap until the reader selects a dated place; a mention of a war in
childhood or family history does not assign that war to the person's service.

The landing retains six slow portrait belts, softened behind the globe and away from the
reading area. Each tile changes every 8–13.6 seconds; the globe follows five real journeys
at a time. GSAP coordinates short, non-blocking entrances and the Archive Register count-up.
Reduced-motion visitors receive final counter values and still photographs and globe.
Without GSAP, the interface and its final counter values remain available. The decorative
mosaic uses only rights-cleared, face-validated OHP assets.
Compact collection/profile photographs also retain rights-cleared detector false negatives;
records without an image keep their initials.

**Portrait provenance:** the project owner identified themselves as the photograph author
and granted reuse permission on 2026-09-02. `data/portraits/manifest.json` records that
permission, the exact OHP source URL, selected profile, and generated asset path for every
portrait. Rebuild with `pip install -r tools/portrait_requirements.txt`,
`python tools/build_portraits.py`, then `python -m pipeline.build`.
Profiles whose live OHP pages contain no uploaded image are listed individually under
`missing_profiles` and retain initials rather than receiving an unrelated photograph.

**Accessibility (doc 02 N1):** keyboard-navigable tabs, a focusable survivor list mirroring
the map, ARIA labels, a skip link, AA-contrast palette, and a fully honoured
`prefers-reduced-motion`.

---

## Data model (`data/`)

`survivors.geojson` — a GeoJSON `FeatureCollection`, one Feature per account, with a
reference point for a mapped place (coordinate order **`[lng, lat]`**), not a verified
personal position. Each waypoint keeps both the
**as-written** name and the **canonical** one. Properties also carry `review_status`
(`pending`/`reviewed`) and `featured`. Also emitted: `place_index.json`
(`canonical place → [survivor_id]`) and `connections.json` (each with a `verified` flag).
`war_context.json` supplies the sourced 1914–2026 belligerent and historical phase context.
`historical_boundaries.json` contains compact, dated OpenHistoricalMap territory polygons;
`historical_boundary_index.json` drives the change-density strip beneath the timeline.
The reproducible builder lives in `tools/historical-boundaries/`. Public accounts that have
no geocoded places have null geometry and empty waypoints, but retain their source and media.
`profile_media` contains credited image references and ordered Vimeo chapter metadata.
`waypoints[].evidence` distinguishes personal, contextual, and uncertain source
attribution. `contextual_places` preserves family background, historical events, and
other non-personal mentions without drawing them as the interviewee's route.
`location_precision` identifies country, region, city, or site references; optional
location notes and source links explain the reference. `birth_date` and uncertain
`date.as_written` values retain the source's precision instead of inventing dates.
`data/source/vimeo_caption_index.json` records public caption availability for every Vimeo
clip linked from public OHP pages across all groups. Full VTT tracks stay in the ignored
`data/source/transcript_cache/`. The published dataset contains chapter references and
caption coverage, not full transcripts or signed caption URLs. Public embed hashes are
retained when the original OHP page supplies them. An inaccessible recording is not
reported as a confirmed captionless recording.

Historical flags use the same mid-year sample as territory geometry. A design change
after that sample appears in the following year. Unverified designs are omitted rather
than replaced with a modern flag. Each displayed flag links to its dated source and rights
information. The comparison control compares dated vector boundaries with today's basemap;
it is not a georeferenced scanned-map overlay. OldMapsOnline is a functional reference and
external catalogue link, not a copied dataset. Its broader historical catalogue, battle and
ruler database, map-upload/georeferencing service, accounts, and commercial features remain
on the original service.
`geocode_cache.json` + `data/source/ohp_scraped.json` are committed so rebuilds are
reproducible and offline. Validated against `data/schema/survivors.schema.json`.

## Accuracy and remaining uncertainty

The map is an index to testimony, not an independently verified reconstruction of every
life or border. Solid route connections use person-linked city/site references.
Country-level, regional, contextual, and unresolved mentions do not become precise route
legs. Ranged or unknown dates are not assigned to a single history year. Shared
historical links require dated endpoints in the same year.

The place table separates formerly conflated references such as Birkenau/Auschwitz I,
Oświęcim town/the camp, Waterloo in Quebec/Kitchener, Falaise/Caen, Juno Beach/Normandy,
and Palestine/the modern state of Israel. Government and museum references are recorded
alongside the relevant cached locations. Broad reference points remain labelled as broad.

Historical geometry comes from a generalized OpenHistoricalMap zoom-zero tile. Its
source vertices are preserved. Historical polity names are not silently replaced with
modern states, and modern country keys are used only for alignment joins. Polygon area
is calculated on the decoded sphere for ranking, not treated as an official land-area
measurement. Identical concurrent outlines are deduplicated for display; overlapping
different outlines remain visible as dashed source alternatives.

The checks are recorded in `data/review/journey_accuracy_audit.json` and
`data/historical_boundary_quality.json`. The geometry report includes the input hash,
CRS, tool versions, validity counts, and temporal overlap pairs. Zero invalid polygons
does not certify historical accuracy. Uncertain source associations still require
human review of the interview.

To regenerate the historical geometry checks, install the isolated development
dependencies from `tools/historical-boundaries/requirements.txt`, then run:

```powershell
node tools\historical-boundaries\build.mjs
python tools\historical-boundaries\audit_geometry.py --write
```

The audit performs no network requests, coordinate repairs, or forced boundary unions.
The browser uses a geometry revision in its request URL so corrected metadata is not
hidden behind an older cached layer.

---

## Auto-update — two interchangeable paths

Both rebuild the dataset from the archive with **zero page-load cost**; new survivors are
staged `pending`, never auto-published as fact (doc 09 Step 2.5).

**A. GitHub Actions** (`.github/workflows/build.yml`) — **CI only**: on push, a weekly
schedule, `workflow_dispatch` (manual), and `repository_dispatch` (a WordPress publish
webhook, type `ohp-publish`). Each run: `pytest` → `pipeline.build` → assemble-site
smoke check → (on scheduled/dispatch) commit changed JSON. The build *fails on invalid
data*. Deployment is handled by Cloudflare (below), not by this workflow.

To resume the veteran-video caption audit without rechecking completed clips:

```powershell
python -m pipeline.vimeo_transcripts --workers 3 --delay 0.3
```

Vimeo clips without a public caption track are recorded honestly as unavailable or
uncaptioned. Auto-generated caption text is cached for source review but is not published
as a quotation because recognition errors can change a veteran's words.

**B. Cloudflare Worker** (`wrangler.toml`, `worker/`) — **the live deployment**. On push,
Cloudflare Workers Builds runs `wrangler deploy`; a `[build]` step assembles a clean
`public/` and the Worker serves it. An hourly **Cron Trigger** checks all six archive
listings, including both Military Veterans indexes, for new interviews. It immediately
processes new profiles and refreshes a rotating bounded batch of existing profiles, so the
entire archive is revisited roughly every two days without hammering Crestwood's site.
Merged GeoJSON and sync status are written to **Workers KV**; `fetch()` serves the current
dataset straight from KV with no OHP request on page load. Human-reviewed records are
never overwritten by automatic extraction.

`GET /__sync/status` reports the last run without exposing private data. Manual refreshes
require a `SYNC_TOKEN` Worker secret and `POST /__sync`; the scheduled refresh needs no
secret.

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
css/         tokens.css + style.css  design tokens + component styles
js/          config · data · atlas (D3 map) · ui (overlays) · app (state)
vendor/      d3, topojson (build), atlas (source), fonts — pinned, self-hosted
data/        survivors.geojson, place_index.json, connections.json, geocode_cache.json,
             gazetteer.json, schema/, golden/, review/, source/ (ohp_scraped + curated)
             atlas-europe.json is generated at build time by tools/build_atlas.cjs
pipeline/    the Python build pipeline (incl. scrape_ohp.py)
worker/      Cloudflare Worker (static deploy + scheduled KV sync)
wrangler.toml  ·  tools/assemble_site.cjs builds public/ (runs build_atlas first)
tests/       pytest suite (run: python -m pytest)
tools/       build_gazetteer.py, build_atlas.cjs, assemble_site.cjs, smoke/shots
docs/        the planning dossier (00–12) + audit/evaluation/improvement-plan
.github/     CI build + validate workflow
```

---

## Requirements traceability

| | Requirement | Where |
|---|---|---|
| F1–F3 | Ingest (scrape), extract, normalize + geocode | `pipeline/scrape_ohp,extract,gazetteer,geocode` |
| F4–F6 | Dots, survivor panel, click-a-place | `js/atlas.js`, `js/ui.js`, `place_index.json` |
| F7 | Filter bar (theme chips) | `js/ui.js` (explore) |
| F8 | Accounts, source media and direct place navigation | `js/ui.js`, `js/media.js`, `js/app.js`, `js/atlas.js` |
| F9 | Patterns: all journeys + shared-place rings + connections | `js/atlas.js`, `connections.json` |
| F10 | Historical atlas, 1914 to 2026 | `js/atlas.js`, `js/historical-context.js`, `js/ui.js` |
| F11 | Deep links | `js/app.js` |
| F12 | Automated rebuild | `.github/workflows/build.yml` + `worker/` |
| N1–N6 | a11y, perf (clustering), mobile, reproducibility, maintainability, resilience | front end + committed cache + CI/Worker validation |
| E1–E5 | Permission, human review, honest uncertainty, original names kept, no new aggregate exposure | the review gate + pending labels, candidate connections, fuzzy dates, `as_written` everywhere |

---

## Credits & licenses

A student project. Story-map inspiration includes HandsOnDataViz
[*Leaflet Storymaps with Google Sheets*](https://github.com/HandsOnDataViz/leaflet-storymaps-with-google-sheets)
by **Ilya Ilyankou & Jack Dougherty**; the visual direction is informed by the Arolsen
Archives' *Transnational Remembrance* map. The vector-atlas front end and the
ingest/extraction pipeline are custom. Built with **D3** (ISC) and **TopoJSON**
(build-time, ISC); basemap geometry from **Natural Earth** via
[**world-atlas**](https://github.com/topojson/world-atlas) (public domain); dated territory
geometry from [**OpenHistoricalMap**](https://www.openhistoricalmap.org/copyright) (CC0);
historical
belligerent participation and entry/exit years derive from the
[**Correlates of War Project Inter-State War Data v4.0**](https://correlatesofwar.org/data-sets/cow-war/);
type set in
**Spectral** and **Public Sans** (SIL OFL). Testimony content belongs to the Crestwood OHP
and the survivors and families — used here only as short excerpts linking back to the
archive. See [`LICENSE`](LICENSE). Code in this repo is MIT.

Made with restraint, in memory of those whose journeys these are.
