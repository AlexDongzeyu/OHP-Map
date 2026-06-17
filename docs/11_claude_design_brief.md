# 11 — Design Brief for Claude Design

> Paste everything below the line into Claude Design. It's written to stand alone.

---

## Brief: an interactive memorial map — "Crestwood OHP: Survivor Journeys"

### What this is
Design the visual system and key screens for an interactive web map that traces the
journeys of Holocaust survivors interviewed by students at Crestwood Preparatory
College (the "Oral History Project"). Each survivor's life is shown as a path across
a map of Europe — from their hometown, through ghettos and camps, to liberation and
their eventual resettlement (many in Toronto). Visitors can follow one survivor's
journey as a guided story, explore all survivors freely, and see aggregate patterns
(including survivors who passed through the same place at the same time).

This is a **memorial**, not a product launch and not a game. The guiding aesthetic
is **dignified restraint**: quiet, spacious, and serious. It should feel like a
well-designed museum exhibit, not a dashboard and not a data-art spectacle.

### Who it's for
- Students and the public who know nothing about the project and need to instantly
  understand what it is.
- Teachers who will link to it and present it in class.
- Survivors' families, who must feel the work is respectful and accurate.

### The core problem to solve
The current site drops visitors onto a near-empty page with a title, three bare tab
labels ("Guided / Explore / Patterns"), and a credits paragraph. A first-time
visitor has no idea what it is or what to do. **Your top priority is an opening
screen that makes the purpose and the first action obvious within five seconds**,
and a coherent visual language across all screens.

---

## Art direction

**Mood:** quiet, reverent, human, timeless. Think archival paper, soft light, a
single warm point of color in a largely monochrome field. Stillness over motion.

**Color palette (propose refinements, but in this spirit):**
- Paper / background: warm off-white (e.g. `#F7F4EF`) and a deep near-black ink for
  text (e.g. `#1A1A18`) — not pure black.
- Map/base: desaturated greys (a Positron-style basemap).
- One restrained accent for journey lines and the active state — a muted ember/amber
  or a deep slate-teal. Exactly one accent; everything else greyscale.
- Optional second, even quieter tone for "visited/inactive" states.
- No rainbow category colors. No bright UI blues. No default map-pin blue.

**Typography:**
- A humanist serif for names, quotes, and headings (gravitas, humanity) — e.g.
  Spectral, Source Serif, Lora, or Newsreader.
- A clean, neutral sans for UI and labels — e.g. Inter or Söhne-like grotesque.
- Generous line-height and spacing. Let names and quotes breathe.

**Texture & imagery:**
- Optional very subtle paper grain; optional faint georeferenced 1930s–40s map of
  Europe as a low-opacity underlay (historical accuracy, never "war-game" styling).
- Survivor portraits, when present, are shown **one at a time, with name and dates**,
  given space — never arranged into a decorative collage. A face is a person.

**Motion:**
- Slow, soft eases (250–450ms). Nothing bounces, nothing loops, nothing autoplays.
- A journey line should *draw itself* gently across the map as a story advances.
- Must fully honor `prefers-reduced-motion` (instant, no animation when set).

**What to avoid:** spectacle, grunge/distressed textures, propaganda or military
iconography, drop shadows everywhere, neon, dense dashboards, anything that makes
suffering look "cool."

---

## Screens to design

1. **Landing / hero (most important).**
   - Instantly answers "what is this?": the title, and one human sentence beneath it
     (e.g. "Following the journeys of Holocaust survivors who shared their stories
     with Crestwood students — from their hometowns to the camps to new lives in
     Toronto.").
   - A dignified hero visual: a quiet map of Europe with a few faint journey lines,
     or a single portrait fading in.
   - A clear primary action ("Follow one journey") and a secondary one ("Explore the
     map").
   - A quiet sense of scale ("N survivors · N journeys · N places").
   - A one-line statement of care/method and a link to "About."

2. **Guided (scrollytelling) view.**
   - A narrative column (left) paired with a pinned map (right); on mobile, narrative
     over map, stacked.
   - Each scroll "chapter" moves the map to the next place in one survivor's journey
     and draws the next leg of the route.
   - Per chapter: a short passage, the place name (as the survivor said it, with the
     modern name beneath), optional portrait or archival image, optional short quote.

3. **Explore view.**
   - Full map; every survivor a quiet dot at their hometown; clustered when zoomed
     out.
   - A filter bar (by camp/place, origin country, theme/keyword).
   - Clicking a dot opens a **survivor side panel** (see component below).
   - Clicking a place highlights everyone connected to it.

4. **Patterns view.**
   - The aggregate: faint arcs of all journeys across Europe; a subtle density of
     origins; a "connections" layer linking survivors who were in the same place at
     the same time (understated, only when verified).
   - A **time scrubber** (≈1933–1950): dragging it moves dots along their routes;
     uncertain dates shown as a soft glow over a range, never a hard point.

5. **Survivor side panel / card (the repeating unit — design it carefully).**
   - Portrait (if rights cleared), name, birth year, hometown.
   - A short bio excerpt and the ordered journey (place · role · approximate date).
   - A small inline map of just their route.
   - A link to their full archive entry. A subtle "verified / approximate" indicator.

6. **About / methodology / credits.**
   - What the project is, how journeys were derived, how uncertainty is handled,
     permissions, and credits (the data source and the open-source tools used).

---

## Components & states to include
- Top nav + mode switch (Guided / Explore / Patterns) — make these legible and
  clearly the primary navigation, not three lonely words.
- Filter chips, marker styles (default / hover / active / clustered), journey-line
  style, the time scrubber, portrait card, quote block, tooltip, the connection
  thread.
- **Empty, loading, error, and no-results states** — design these explicitly. (The
  site is currently *in* an empty state with no design for it, which is much of why
  it reads as broken.)

## Non-negotiable constraints
- **Accessibility:** WCAG AA contrast, visible focus states, full keyboard
  operability, screen-reader labels, reduced-motion support.
- **Mobile-first:** all screens must work stacked on a phone.
- **Restraint:** when a choice is between more impressive and more respectful, choose
  respectful. That choice *is* the brand.

## What I want back from you
1. A cohesive **visual system**: color tokens, type scale, spacing, motion rules.
2. **High-fidelity mockups** of: landing/hero, guided chapter, explore + open side
   panel, patterns + time scrubber, and the survivor card.
3. The **empty/loading** states for the map.
4. A short **style guide** I can hand to a developer to implement in CSS variables.

Design for emotional clarity and quiet beauty. The measure of success: a stranger
lands, understands in five seconds, and feels invited to follow one person's life.
