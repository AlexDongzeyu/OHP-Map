# 05 — Prototype Playbook (fork-first)

This is the file to act on. The previous docs describe the full vision; this one
gets a real, live, good-looking thing on the internet **this weekend** by adapting
an existing open-source project instead of building from scratch.

---

## The strategy: buy, then build

You asked the right question — *can I take an existing project and make it mine?*
For a first prototype, yes, and you should. The professional name for this is
"buy then build": start from a proven template to validate the idea and get
something demoable fast, then invest custom engineering only where the template
can't reach. Building all of it from scratch first is the rookie move; it's slower
and you learn less per hour.

There is a template built for almost exactly this: **HandsOnDataViz "Leaflet
Storymaps with Google Sheets."** It's <cite>a scroll-driven story map with point
markers and narrative text, supporting images, audio, and video embeddings</cite>,
it's <cite>responsive — stacked on phones, side-by-side on wide screens</cite>, and
the demo already renders on **CARTO** basemaps (the quiet, museum-tone tiles from
doc 01). It's open source, taught step-by-step in a free online book, and forked by
hundreds of people. That is your prototype base and, later, your "Guided mode."

Repo: https://github.com/HandsOnDataViz/leaflet-storymaps-with-google-sheets
Live demo: https://handsondataviz.github.io/leaflet-storymaps-with-google-sheets/
Tutorial: https://handsondataviz.org/leaflet-storymaps-with-google-sheets.html

---

## What to reuse vs. what to build (think carefully here)

The honest engineering call. The template is a **linear, point-by-point guided
tour**. It is not a 200-dot free-explore map. So:

| Feature | Reuse the template? | Why |
|---------|--------------------|-----|
| Guided scrollytelling intro | ✅ Reuse | This is literally what the template is for |
| Responsive layout + media embeds | ✅ Reuse | Already solved, well-tested |
| CARTO quiet basemap | ✅ Reuse | Already wired in |
| Journey line that draws itself | ➕ Add a plugin | Template centers on points; add SnakeAnim (see doc 06) |
| 200 dots + clustering | ⚠️ Build | Outgrows a linear tour; needs a custom Leaflet view |
| Faceted filter bar (camp/origin/tag) | ⚠️ Build | Not in the template |
| Place click → all connected survivors | ⚠️ Build | Needs the precomputed index from doc 02 |
| Patterns mode (flow lines, density) | ⚠️ Build | Custom aggregate views |
| Time scrubber | ⚠️ Build | Custom; use MovingMarker (doc 06) later |
| WordPress auto-update pipeline | ⚠️ Build | Your Python pipeline from doc 02 |

Translation: **the template = your prototype and your Guided mode. The Explore,
Patterns, and scrubber features = a second, custom Leaflet app you build afterward,
reusing the same data.** Nothing in the prototype is throwaway — see the migration
path at the bottom.

---

## Ethics of reuse (do not skip)

"Open source" is not "no obligations," and "make it mine" must not become "pass off
someone's work as wholly my own."

- **Fork the code template; supply your own data, styling, and the custom features.**
  Do not clone or scrape someone's *live* site and relabel it.
- **Keep the credits.** The template's README lists its authors (Ilya Ilyankou and
  Jack Dougherty) and its open-source components and their licenses (Leaflet is
  BSD-2-Clause). Leave that intact and add your own credit alongside it.
- **Read the `LICENSE` file** of anything you fork before you rely on it; follow it.
- In your write-up / college essay, be straight about what you started from and what
  you built. "I forked X and added a custom extraction pipeline, a clustered explore
  view, and a connection layer" is a *stronger* story than pretending you wrote every
  line — it shows judgment about when to reuse.

---

## The weekend prototype, step by step

Scope is deliberately tiny: **3–5 survivors, guided tour, restyled, live.** Resist
adding anything else until this is on the internet.

### Day 1 — Get a live map with your content (a few hours)

1. **Fork** `HandsOnDataViz/leaflet-storymaps-with-google-sheets` to your GitHub.
2. In your fork: **Settings → Pages → deploy from `main`.** Within a minute you
   have a live URL showing the demo (the US National Mall story). You now have a
   working deployment before writing any code. This is the most important habit in
   the whole project: deploy first, iterate second.
3. **Pick 3–5 anchor survivors** from `ohp.crestwood.on.ca` whose testimonies have
   clear places and a clean arc (hometown → camp(s) → liberation → Toronto).
4. **Enter their data.** Two options:
   - *Fastest:* copy the linked Google Sheet template, replace the sample rows with
     your survivors (one row per stop on the journey: title, description, lat, lng,
     media URL, chapter). Geocode addresses with the free **Geocoding by
     SmartMonkey** Sheets add-on the template recommends.
   - *Cleaner (and the migration path):* skip Sheets and edit the local
     **GeoJSON/CSV** the template can read instead. This removes the Google
     dependency and matches the `survivors.geojson` schema from doc 02.
   - For each place, store the survivor's **as-written** name and the **canonical**
     modern name (the Lemberg→Lviv rule from doc 01).
5. Commit. Your live URL now tells real Crestwood stories. **Stop and look at it on
   your phone.**

### Day 2 — Make it yours and make it better (a few hours)

6. **Basemap & palette:** confirm it's on CARTO Positron / a `nolabels` variant;
   set one muted accent color for journey lines, one for the active state, grayscale
   for the rest. Kill any default blue markers.
7. **Draw the journey:** add **Leaflet.Polyline.SnakeAnim** (doc 06) so each
   survivor's route *creeps across the map* as you arrive at their chapter instead
   of just snapping between points. This single effect is what makes it feel alive.
8. **Title, intro, and framing copy:** restrained tone, a one-line dedication, a
   short "how to read this map" note. Keep the credits to the original template.
9. **Accessibility quick pass:** check color contrast, make sure you can tab through
   chapters, and add `prefers-reduced-motion` handling so the animation doesn't play
   for users who opt out.
10. Commit, reload the live URL, and send it to Mr. Masters as a proof of concept.

That's the prototype. It is genuinely demoable, genuinely yours, and it took a
weekend because you didn't reinvent the scrolly map engine.

---

## Prototype scope (pin this down so it can't grow)

**In:** fork + deploy, 3–5 survivors, guided scroll tour, SnakeAnim journey line,
quiet basemap + restrained palette, basic a11y, mobile check, credits.

**Out (for the prototype, not forever):** the WordPress pipeline, LLM extraction,
all 200 survivors, clustering, filters, place-click index, Patterns mode, time
scrubber, the connection layer, automation. These are doc 02's later phases.

---

## How the prototype grows into the full product (no throwaway work)

The point of starting here is that every prototype artifact feeds the real thing:

- The **data you hand-entered** locks in your schema and becomes the first rows your
  Python pipeline must reproduce — your pipeline's "golden set."
- The **forked storymap** becomes the **Guided mode** of the finished site,
  unchanged.
- Switching the template's data source from Google Sheets to a **pipeline-generated
  GeoJSON** is the bridge from prototype to automation (doc 02, Phase 2/5).
- The **Explore / Patterns / scrubber** views become a second custom Leaflet page in
  the same repo, reading the same GeoJSON. The prototype and the custom app share one
  dataset.

So the path is: fork → prototype (this doc) → pipeline feeds the same template
(doc 02 Phases 2–3) → custom explore/patterns app added alongside (doc 02 Phase 4)
→ automation (doc 02 Phase 5). Linear, additive, nothing wasted.

---

## Prototype Definition of Done

- Live public URL on GitHub Pages.
- 3–5 real Crestwood survivors with verified places and preserved as-written names.
- Guided scroll tour with a self-drawing journey line.
- Quiet basemap, restrained palette, works on a phone, reduced-motion respected.
- Original template credits retained; your own credit added.
- Sent to Mr. Masters for a reaction before you invest in the pipeline.
