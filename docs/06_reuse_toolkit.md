# 06 — Reuse & Animation Toolkit

The shortlist of existing projects to adapt and plugins to drop in, each mapped to a
feature and a license. Everything here is free and open source. Reusing these is how
you punch above your weight: you spend your effort on the parts that are unique to
*your* project (the data, the connection layer, the meaning) instead of re-solving
problems other people already solved well.

---

## Forkable base templates

### 1. HandsOnDataViz — Leaflet Storymaps with Google Sheets  ← your base
Scroll-driven guided tour; markers + narrative; image/audio/video embeds;
responsive; CARTO basemaps; data via Google Sheets, CSV, or GeoJSON.
- **Use it for:** the prototype and the final Guided mode.
- **Limits:** linear tour, not a free-explore 200-dot map; uses jQuery.
- **License:** open source; built on Leaflet (BSD-2-Clause). Keep the credits.
- https://github.com/HandsOnDataViz/leaflet-storymaps-with-google-sheets
- Tutorial: https://handsondataviz.org/leaflet-storymaps-with-google-sheets.html

### 2. Knight Lab — StoryMapJS
No-code/low-code guided map stories. Easiest possible start.
- **Use it for:** a 30-minute throwaway mock to feel the format, or if you want
  zero build. The HandsOnDataViz authors themselves note Knight Lab <cite>lacks
  advanced features but offers a basic introduction for beginners</cite>.
- **Limits:** least customizable; you'll outgrow it immediately for the real vision.
- https://storymap.knightlab.com/

### 3. MUX Lab — Map Effects 100
The scroll-driven navigation effect the HandsOnDataViz template was <cite>adapted
from</cite> — a catalog of 100 small Leaflet effects.
- **Use it for:** raiding individual interaction patterns (scroll-driven map nav,
  transitions) when you build the custom Explore/Patterns app.
- https://github.com/muxlab/map-effects-100

---

## Leaflet animation & UX plugins (this is what makes it "look way better")

Each is a small, self-contained add-on. Add them one at a time; test after each.

### Leaflet.Polyline.SnakeAnim — the self-drawing journey line ★ prototype
Animates a polyline so it <cite>creeps into its full length</cite>; call
`.snakeIn()`, control speed with `snakingSpeed`, and it fires `snakestart` / `snake`
/ `snakeend` events you can hook into. For a layer group it animates marker→line→
marker in sequence with `snakingPause`.
- **Powers:** the journey drawing across the map as a chapter loads. The single
  highest-impact visual upgrade for the prototype.
- **License:** Beerware (do whatever, keep the notice). Needs Leaflet ≥ 1.1.
- https://github.com/IvanSanchez/Leaflet.Polyline.SnakeAnim

### leaflet-ant-path — directional "marching ants" flux
A polyline with an animated dashed flux showing direction of travel; configurable
`delay`, `dashArray`, `color`, `pulseColor`, `reverse`.
- **Powers:** showing the *direction* of a journey or a deportation route; good for
  flow lines in Patterns mode.
- **License:** open source (npm/Bower/Yarn). Leaflet ≥ 1.
- https://github.com/rubenspgcavalcante/leaflet-ant-path

### Leaflet.MovingMarker — a marker that travels a path over time
Moves a marker along a polyline with pause/resume, stations, loop, and events;
<cite>compatible with Leaflet 1.9</cite> and uses `requestAnimationFrame`.
- **Powers:** the **time scrubber** — dots traveling along their routes as you drag
  through 1933–1950. (Phase 4, not the prototype.)
- https://github.com/syonfox/Leaflet.MovingMarker

### Leaflet.curve — Bézier curves and arcs
Draw curved paths instead of straight segments.
- **Powers:** elegant arced flow lines in Patterns mode (arcs read as "movement"
  better than straight lines and reduce visual clutter when many overlap).
- https://github.com/elfalem/Leaflet.curve

### Leaflet.markercluster — group nearby markers
Clusters markers at low zoom, expands on zoom-in.
- **Powers:** keeping 200+ hometown dots smooth and readable, especially on mobile.
  Essential for Explore mode.
- https://github.com/Leaflet/Leaflet.markercluster

---

## Feature → plugin cheat sheet

| Feature you're building | Reach for | Phase |
|-------------------------|-----------|-------|
| Journey line draws itself | Leaflet.Polyline.SnakeAnim | Prototype |
| Quiet, serious basemap | CARTO Positron tiles | Prototype |
| Direction of a route | leaflet-ant-path | Patterns |
| Arced flow lines | Leaflet.curve | Patterns |
| 200 dots stay smooth | Leaflet.markercluster | Explore |
| Dots move through time | Leaflet.MovingMarker | Scrubber |
| Non-map connection graph | d3-force or Cytoscape.js | Optional |

---

## Visual upgrades (use with restraint — see doc 08)

For the "make it stunning" layer. Add only on top of a working, accessible 2D map,
and read doc 08 on tone before you touch any of these.

| Want | Reach for | Restraint rule |
|------|-----------|----------------|
| A 3D "scale of displacement" intro | MapLibre globe / deck.gl `GlobeView` | Establishing shot only; no fly-throughs; never reconstruct a camp |
| Raised journey arcs across Europe | deck.gl `ArcLayer` (interleaved with MapLibre) | One muted accent; overview, not spectacle |
| A period "WW2-era" feel | David Rumsey georeferenced 1930s–40s Europe overlay | Accurate cartography only; no grunge/propaganda styling |
| Humanize with faces | Dignified portraits (Yad Vashem / #WeAreHere / Lonka Project as models) | One face + name at a time; rights cleared per person; never a decorative collage |

The governing rule for all of these: a 2D, low-power, screen-reader-friendly map is
the canonical product; 3D and imagery are enhancements with graceful fallbacks.

## Rules for adding any dependency

1. **One at a time, test after each.** A broken plugin is easy to find if it's the
   only thing you just added.
2. **Pin versions** and keep a local copy rather than relying on a random CDN that
   could vanish — this site is meant to last.
3. **Check the license and keep notices.** All of the above are permissive; honor
   them.
4. **Prefer fewer, smaller dependencies.** Every one is code you're trusting to run
   on a memorial. If a built-in Leaflet feature does the job, use that instead.
5. **Respect `prefers-reduced-motion`.** Animation is an enhancement, never a
   requirement to understand the content.
