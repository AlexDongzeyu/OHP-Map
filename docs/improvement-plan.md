# Improvement Plan — Phase 3 (doc 12)

Prioritized, data-blocker-first. Status reflects this iteration. Each item lists the
change, files touched, libraries, and an acceptance check.

| # | Item | Status | Files | Acceptance check |
|---|------|--------|-------|------------------|
| 1 | **Fix "0 journeys"** — serve real data | ✅ done | `pipeline/scrape_ohp.py`, `data/survivors.geojson`, `worker/` | Live `/data/survivors.geojson` is 200 with `count:221`; `#survivor-count` renders 221 |
| 2 | **Rebuild the landing** (purpose, scale, primary/secondary actions, hero) | ✅ done | `index.html`, `js/app.js`, `js/hero.js`, `css/style.css` | First load shows intro with scale + two actions; "Follow one journey" reveals the shell |
| 3 | **Design system** (serif/sans, tokens, one accent, spacing, motion) | ✅ done | `css/tokens.css`, `vendor/fonts/`, `css/style.css`, `js/config.js` | Spectral+Inter load self-hosted; one ember accent; AA contrast |
| 4 | **Empty / loading / error / no-results states** | ✅ done | `index.html`, `css/style.css`, `js/app.js`, `js/explore.js` | Map loading element exists; data error shows a friendly message; Explore shows "N of 221" |
| 5 | **About / methodology surface** | ✅ done | `index.html`, `js/app.js` | About modal opens from the tab, intro link, and banner "Why?"; Esc/backdrop close |
| 6 | **Signature effect** — self-drawing journey lines | ✅ done (kept) | `js/guided.js` (SnakeAnim), `js/hero.js` | Guided draws each leg; reduced-motion draws instantly |
| 7 | **CSS `hidden` bug** (invisible modal eating clicks) | ✅ fixed | `css/style.css` | `[hidden]{display:none!important}`; smoke test clicks land |
| 8 | **Auto-update pipeline** (Cron + KV, KV optional) | ✅ done | `worker/index.js`, `worker/sync.js`, `wrangler.toml` | Deploys with no setup; cron no-ops without KV; documented opt-in |
| 9 | **Explore + Patterns + scrubber on full data** | ✅ done | `js/explore.js`, `js/patterns.js`, `js/scrubber.js` | 221 clustered dots; filters; scrubber places dots per year |
| 10 | **Accessibility + mobile pass** | ✅ done | `css/style.css`, all `js/` | Keyboard through intro/tabs/modal; stacked mobile layout; reduced-motion |

## Deferred (intentional, documented)

| # | Item | Why deferred |
|---|------|--------------|
| D1 | Migrate map engine to **MapLibre GL** + deck.gl `ArcLayer`/`GlobeView` | The accessible 2D Leaflet map is the canonical product (doc 08). Migrate only after fundamentals; large change, modest marginal gain right now. |
| D2 | **Verify** records (pending → reviewed) and promote candidate→verified connections | Human + permission work, not code (docs 04/08). The gate and the workflow exist; running it is the next human step. |
| D3 | **Whole-taxonomy ingest** (add Military Veterans etc.) | v1 is Holocaust survivors (cleanest arc). The scraper is structured so another `ohp-type` term is a config change, not a rewrite (doc 10 scope note). |
| D4 | **Two distinct entry points** (full-page story vs. embeddable explore) | The embed snippet exists; a separate full-page scroll story is a future split since scroll stories don't iframe well (doc 10). |
| D5 | Rights-cleared **portraits** | Needs per-person permission; the dignified one-at-a-time slot is built and gated on `portrait_rights`. |

## Verification performed this iteration
- `python -m pytest -q` — full suite green.
- `node tools/smoke.cjs` — 11 checks incl. intro→shell, all modes, scrubber, About,
  deep links; **zero console errors**.
- Screenshots of landing / guided / explore / patterns / mobile reviewed for craft.
- Live-URL headless check renders 221 with no errors.
