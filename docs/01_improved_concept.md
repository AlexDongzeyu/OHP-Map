# 01 — Improved Concept

This document upgrades the original "every survivor is a dot, click to see their
journey" idea. The core is still good. The improvements make it more meaningful,
more honest, and more impressive — without adding architecture you don't need.

---

## The central insight to design around

200 testimonies stored alphabetically hide their own patterns. A person reading
entry by entry can never see that two survivors passed through the same camp in
the same winter, or that a dozen journeys all funnel through one transit point.
**The product's entire reason to exist is to make the invisible structure of 200
individual stories visible.** Every feature below is judged against that.

So the map is not the goal. The map is one of three lenses on the same dataset.

---

## Three modes, one dataset

A common failure of "interactive map" projects is dropping a first-time visitor
onto a blank map covered in 200 dots with no idea where to look. Fix that by
offering three ways in, in increasing order of agency.

### 1. Guided mode (scrollytelling)
A narrated walkthrough of **one** survivor's journey. As the visitor scrolls, the
map pans, zooms, and draws the route one leg at a time, with a caption beside each
leg. This is the "tutorial" that teaches the visual language (dot = a place in a
life, line = a journey) before handing over control. Built with **Scrollama**,
which fires events as text blocks enter the viewport — the standard, lightweight
way to bind scroll position to map state.

*Why it matters:* it gives the project an emotional on-ramp and a clear beginning,
middle, and end, which a free-explore map never has on its own.

### 2. Explore mode (the interactive map)
Free exploration. This is your original idea, refined:
- Every survivor = a dot at their hometown.
- Click a survivor → side panel: name, the place names **as they said them**, bio
  excerpt, journey line, media if available, link to the full archive page.
- Click a camp/ghetto → every Crestwood survivor connected to it highlights, and
  the panel lists them. (Backed by a precomputed `place → [survivor]` index so
  this is instant, not a scan.)
- A **filter bar** replaces the site's broken search: filter by camp, origin
  country, theme tag (the archive already tags entries — Theresienstadt,
  Kristallnacht, Hidden Child, etc.), or free text.
- **Deep links:** `#/survivor/rosa-blum` and `#/place/auschwitz` so a teacher can
  send a class straight to one story or place.

### 3. Patterns mode (the thesis view)
The aggregate lens — what you can only see from above:
- **Flow lines:** common routes drawn as weighted arcs (many journeys through one
  transit camp become a thick line).
- **Origin density:** where survivors came from, as a subtle heat layer.
- **The connection layer:** survivors who overlapped in the same place at the same
  time, drawn as links between their dots. This is the discovery moment, made into
  a permanent, browsable feature instead of a one-time anecdote.

---

## The time scrubber (the centerpiece)

A slider across the bottom, roughly **1933–1950**. Drag it and every survivor's
dot moves to where they were at that moment, tracing along their journey line.
Pause on 1944 and you can *watch* dots converge on Auschwitz — the "same camp,
same time" coincidence stops being a statistic and becomes something you see
happen. This single interaction does more narrative work than any amount of text.

*Honest constraint:* testimony dates are often fuzzy ("the winter of '44"). The
scrubber must represent that as a fuzzy presence (a place becomes "active" over a
date *range*, with visual softness), never as false precision. Encoding
uncertainty honestly is part of the design, not a limitation to hide.

---

## A connection graph (optional, high-impact)

Beyond geography, add a non-map view: a force-directed graph where each survivor
is a node and an edge connects two people who shared a camp/transport/time window.
The map shows the *geography of separation*; the graph shows *human intersection*.
For a college portfolio this also demonstrates you can model the same data two
structurally different ways. (Library: d3-force, or Cytoscape.js.)

---

## Make it look like it belongs in a museum

The fastest way a serious map looks amateur is the default OpenStreetMap basemap —
busy, colorful, fighting your data for attention. Three decisions fix the tone:

1. **Desaturated basemap.** Use **CARTO Positron** (or a labels-under variant).
   Stamen designed Positron and Dark Matter specifically as quiet backdrops for
   data overlays, with a compressed, desaturated palette so the basemap gets out
   of the way. Free with attribution. Tile URL pattern:
   `https://{s}.basemaps.cartocdn.com/{style}/{z}/{x}/{y}{r}.png`
   with styles like `light_all`, `light_nolabels`, `dark_all`.
2. **A restrained, deliberate palette.** One muted accent for journey lines, a
   second for the active/selected state, grayscale for everything else. No
   rainbow category colors.
3. **No playful motion.** Smooth, slow transitions only. Respect
   `prefers-reduced-motion`. Nothing bounces.

If you want fully custom cartography later, **MapLibre GL** + vector tiles lets you
restyle every layer (there's an open Positron GL style to start from). Start with
Leaflet + Positron raster tiles; it's simpler and gets you 90% of the look.

---

## Data extraction: use an LLM as the primary engine

The original plan used spaCy NER + a gazetteer. That still has a role, but recent
benchmarks change the recommendation for *this specific* task.

**Why an LLM is the better primary tool here:**
- Your entities are *rare and out-of-domain* (historical camp/ghetto/town names).
  Benchmarks consistently find LLMs beat fine-tuned models exactly on novel/rare
  entity types, where a general NER model under-recalls.
- You don't just want a flat list of place names — you want **structured journeys**
  (place + role + approximate date + order) in one pass. An LLM can return that as
  JSON directly; spaCy gives you spans you'd then have to assemble yourself.
- Your corpus is tiny (~200 docs, occasional additions). The cost/throughput
  arguments against LLMs (which apply at 100k+ sentences/day) are irrelevant here.
  GPT-class and Claude-class models hit ~0.93 F1 on structured-JSON NER prompts.

**Why you still keep a deterministic layer:**
- LLMs over-extract and, in studies, their most common error is assigning the
  *wrong type* to a correctly-found entity. So you cross-check LLM output against a
  curated **gazetteer of known camps/ghettos** (force-match the canonical ones)
  and flag anything the LLM invented that the text doesn't support.
- Determinism matters for a published memorial. The gazetteer + a validation pass
  give you a reproducible backstop around the probabilistic extractor.

**The recommended pipeline:** LLM extracts a structured journey per testimony →
gazetteer/rule pass validates and normalizes known sites → everything low-confidence
is queued for **human review** → only confirmed records geocode and publish.

---

## The geocoding problem, restated (your biggest correctness risk)

A survivor's "Lemberg" is today's **Lviv** (also Lwów, Lvov, Leopolis depending on
the era). Naively geocoding the spoken spelling yields wrong or empty pins. The
fix is a **normalization step before geocoding**:

1. Map historical/German/Yiddish/Polish exonyms → one canonical modern name.
2. Geocode the canonical name **once**, at build time, and **cache** the coords in
   your dataset. Never geocode in the browser or on every build.
3. Always keep and display the original "as written" name too — it's how the
   survivor named their own home, and erasing it would be its own small harm.

Resources that already solved this: the **GeoNames `alternateNames`** dataset
(programmatic exonym resolution, runs locally, no rate limits), the **JewishGen /
Galician town gazetteers**, and **USHMM's** geographic-name-expansion search as a
reference for which spellings map together.

---

## Visual design & emotional register

Make it beautiful through restraint, not spectacle. The full reasoning and the
research behind it are in doc 08; the short version:

- **Quiet basemap, period option.** CARTO Positron by default, with an optional
  toggle to a faint *georeferenced historical map* of 1930s–40s Europe (David Rumsey
  collection) so visitors see the borders and names survivors actually knew. This is
  the tasteful way to evoke the era — accurate cartography, not a stylized "war"
  look. No grunge textures, propaganda fonts, or military iconography.
- **Gentle 3D as an establishing shot only.** A slow globe (MapLibre globe) or raised
  journey arcs across Europe (deck.gl `ArcLayer`) can convey the scale of
  displacement. Overview only — no fly-throughs, and never a 3D reconstruction of a
  camp. A 2D, accessible version is always the baseline; 3D is enhancement.
- **Dignified portraits, never a collage.** Real faces with names and dates,
  presented one at a time with space around them, humanize the data. A decorative
  "collage of people" turns victims into texture — avoid it. A face is a person, not
  a design element. Only use photos you have explicit rights to.
- **Motion:** slow, never looping, `prefers-reduced-motion` honored.

The register to aim for is spacious and slow: one face, one name, one route at a
time, with the scale landing through the data rather than through effects.

## Ethics & tone requirements (treat these as functional requirements)

- **Consent/permission** from Mr. Masters in writing before ingest.
- **Human verification** before any extracted fact is published, especially the
  "two survivors overlapped" connections — those assert something about real
  people and must be confirmed against the testimonies.
- **Uncertainty is shown, not smoothed.** Fuzzy dates look fuzzy.
- **The survivor's own words for places are preserved** alongside canonical names.
- **Accessibility:** keyboard navigable, screen-reader labels on markers/panels,
  sufficient contrast, reduced-motion honored. A memorial that excludes disabled
  visitors fails on its own terms.
- **Restraint in everything** — copy, color, motion, sound.

---

## What success looks like

- A visitor with no context can land, be guided through one story, then explore.
- A teacher can link directly to a survivor or a place.
- A new testimony published in WordPress appears on the map automatically.
- At least one genuine, verified "same place, same time" connection is surfaced
  that was not previously obvious from the archive — the thing that proves the
  whole project's premise.
