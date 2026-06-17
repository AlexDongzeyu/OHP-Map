# 07 — Prototype Build Prompt (fork & adapt)

Use this prompt for the **prototype** — it's the fork-and-adapt counterpart to the
from-scratch prompt in doc 04. Run it in **Claude Code**, in the folder where you've
cloned your fork. Replace the `<…>` placeholders first. It is intentionally small in
scope: a weekend, 3–5 survivors, guided tour, restyled, live.

When the prototype is approved by Mr. Masters, switch to doc 04 for the full build.

---

```text
You are helping me adapt an existing open-source template into a prototype map of
Holocaust survivor journeys from the Crestwood Oral History Project. We are NOT
building from scratch and NOT building the full product yet. Scope = a guided
scroll-tour of 3–5 survivors, restyled, deployed live. Work in small steps and STOP
after each step to show me the result.

# STARTING POINT
- This repo is my fork of HandsOnDataViz/leaflet-storymaps-with-google-sheets
  (a scroll-driven Leaflet story map; data via Google Sheets, CSV, or GeoJSON;
  responsive; CARTO basemaps; supports image/audio/video embeds).
- First, read the existing README and source so you understand how it loads data and
  renders chapters. Summarize how it works back to me before changing anything.

# CONTEXT & VALUES
- Real Holocaust testimony about real people. Accuracy and restraint over flash.
- Data source for the real project is the WordPress archive at
  https://ohp.crestwood.on.ca, but for THIS prototype I will hand-enter 3–5
  survivors — do not build a scraper or pipeline yet.
- I have (or am getting) Mr. Masters' permission. Do not ingest anything in bulk.

# MY INPUTS
- 3–5 anchor survivors with their journeys (place name as-written + canonical modern
  name + lat/lng + role + short description + archive URL + optional media):
  <paste here, or tell me to give you a template to fill in>

# WHAT TO DO (stop after each numbered step)

1. ORIENT. Explain how this template ingests data and builds chapters, and identify
   exactly where I plug in (the Google Sheet/CSV/GeoJSON, the basemap tile URL, the
   color/CSS, and where markers/polylines are created). Don't change code yet.

2. DATA SOURCE. Switch the template to read a LOCAL GeoJSON file I control instead of
   (or in addition to) Google Sheets, so there's no external dependency. Define the
   GeoJSON to match this shape per survivor: id, name, bio_excerpt, archive_url,
   media_url, and an ORDERED waypoints array of
   {as_written, canonical, role, lat, lng, description}. Put my 3–5 survivors in it.
   Keep BOTH the as-written and canonical place names; display as-written in the
   narrative, canonical in a subtle subtitle.

3. JOURNEY LINE. Add Leaflet.Polyline.SnakeAnim. When a survivor's chapter becomes
   active, draw their route across the map by connecting their waypoints in order
   with an animated polyline (.snakeIn()). Use the snakeend event to know when it's
   done. Keep one muted accent color for the line. Respect prefers-reduced-motion:
   if the user opts out, draw the line instantly with no animation.

4. LOOK. Confirm the basemap is CARTO Positron (or a nolabels variant) with proper
   attribution. Apply a restrained palette: grayscale base, one accent for journey
   lines, one for the active marker. Remove default blue markers. No bouncing or
   auto-playing motion anywhere.

5. FRAMING. Add a short, restrained intro panel: a title, a one-line dedication, and
   a 2-sentence "how to read this map." Keep the original template's credits intact
   and add my credit beside them. Note the data is a small prototype sample.

6. ACCESSIBILITY & MOBILE. Keyboard navigation through chapters, ARIA labels on
   markers and the narrative panel, AA color contrast, and a verified
   prefers-reduced-motion path. Confirm the responsive layout works at phone width.

7. SHIP. Make sure GitHub Pages serves the current build. Give me the live URL and a
   short list of what changed from the upstream template (so I can describe my work
   honestly).

# CONSTRAINTS
- Do NOT add: clustering, filters, place-click index, Patterns mode, time scrubber,
  the WordPress pipeline, or all 200 survivors. Those are the next project (doc 04).
- Restraint over spectacle (this is a memorial): no 3D camp reconstructions, no AR,
  no "war"-styled grunge/propaganda look, no decorative face collages. If I want
  period flavor, the only tasteful option is a faint georeferenced historical-Europe
  map overlay — accurate cartography, optional, off by default.
- Only use photos/quotes I have rights to; show portraits dignified, one at a time,
  with name and dates; prefer linking to the full archive entry over reposting text.
- Add dependencies one at a time, pinned, with a local copy (no fragile CDNs). Keep
  and honor all upstream licenses/credits.
- Clean, commented changes I can learn from. Explain WHY for each non-obvious choice
  and flag anything in the upstream code that's a bug or a bad habit. Small commits
  with clear messages. Update the README to describe my changes.
```

---

## After you run it

- **Look at it on a real phone**, then send the live URL to Mr. Masters. The whole
  point of a prototype is to get a reaction before you build the expensive parts.
- **Keep the GeoJSON you hand-entered** — it becomes the golden set your future
  pipeline (doc 04) must reproduce, so the prototype work directly seeds the product.
- When you're ready for the full build, the data source swap (local GeoJSON →
  pipeline-generated GeoJSON) is the single bridge between this prototype and the
  automated system in doc 02 / doc 04.
