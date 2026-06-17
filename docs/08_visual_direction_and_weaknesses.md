# 08 — Visual Direction & Weakness Audit

**Read this before you build anything visual.** You asked two things here: make it
beautiful, and tell you where the plan is weak. Those turn out to be the same
conversation, because the visual direction you described is also the plan's biggest
risk. I'm going to be direct, because you asked me to be and because the subject
deserves it.

---

## Part A — Your visual instinct, answered honestly

Wanting it to be striking, immersive, and emotionally powerful is the *right*
instinct. A flat map of gray dots would undersell these lives. So the goal is good.
The specific forms you named — 3D, an "AR feeling," mimicking WW2, a collage of
people — are where I want to slow you down, because the subject changes the rules.

**What the scholarship actually says.** There's a large literature on representing
the Holocaust digitally, and it converges on one warning: death and suffering are
easily "transformed into a spectacle," and memorials can slide into "edutainment"
where atrocity becomes something a visitor *consumes* rather than witnesses.
Historian Tim Cole went as far as calling the amenities around Auschwitz-Birkenau a
"Holocaust theme park." There is even a specific body of work on 3D and virtual
reconstructions of camps as "virtual traumascapes," and a whole sub-field on the
ethics of interactive/VR storytelling at atrocity sites. The recurring ethical
axes are respect and sensitivity, human dignity, accuracy of narrative, and the
danger of distortion. None of this says "don't be creative." It says **the more
immersive and dramatic the device, the higher the risk it tips from memorial into
spectacle.**

**The test for every visual decision.** Ask: *does this help a visitor understand
and remember a real person, or does it turn that person's suffering into an
experience the visitor enjoys?* Restraint reads as respect. When in doubt, do less.

### Your three ideas, triaged

**1. "3D / AR type of feeling"**
- **True AR (camera / WebXR): drop it.** It doesn't fit a map embedded on a school
  homepage, its accessibility is poor (camera, motion, device support), it's a large
  build, and it pushes hardest toward the immersive-spectacle problem above. Wrong
  tool, wrong place.
- **A gentle 3D *overview*: acceptable with strict limits.** A slowly rotating globe
  (MapLibre's globe projection or deck.gl `GlobeView`) or **raised arcs** linking
  origin to destination across Europe (deck.gl `ArcLayer`) can genuinely convey the
  *scale of forced displacement* — hundreds of lives scattered across a continent.
  Rules if you use it: overview only; no "fly-through" camera moves; **never
  reconstruct a camp, ghetto, or atrocity site in 3D**; and always ship a plain 2D
  version as the default and fallback. The globe is an establishing shot, not the
  whole film.

**2. "Mimic WW2"**
- The tasteful version of this is **period-accurate cartography, not a war-game
  look.** Overlay a *georeferenced historical map* of 1930s–40s Europe — the David
  Rumsey collection has georeferenced historical maps you can drape over a modern
  map — so visitors see the borders, countries, and place-names the survivors
  actually knew (the Europe where "Lemberg," not "Lviv," was the name). That is
  scholarly, moving, and defensible.
- **Avoid:** distressed "grunge" textures, propaganda-style fonts, swastika/military
  iconography, barbed-wire borders, and sepia-for-mood. Those *aestheticize*
  atrocity — they make it look cool — which is exactly the trivialization the
  literature warns against. Historical accuracy is reverent; stylized "war vibes"
  are not.

**3. "A pretty collage of people in the scene"**
- Redirect from *decorative collage* to **dignified portraiture.** Real survivor
  faces, shown one at a time with their name and dates, humanize the data and are
  deeply powerful — this is what Yad Vashem, the IDF's #WeAreHere project, and the
  Lonka Project do. A *collage* — faces arranged for visual effect, blended into a
  "scene" — does the opposite: it turns people into texture and pattern. **A face is
  a person, not a design element.** One portrait, with a name, given space, beats a
  hundred in a mosaic.
- **Hard prerequisite:** you must have the *rights* to use any photo. Archive
  portraits, family photos, and testimony stills all carry rights and often
  sensitivities. Confirm permission per person with Mr. Masters before a single face
  goes online. "Available on the site" is not the same as "cleared for republication
  in a new context."

### The emotional register to aim for
Quiet, spacious, slow. One face, one name, one route at a time. Let whitespace and
stillness carry weight. The scale should hit the visitor through the *data* — 200
separate journeys converging on the same few places — not through effects. That
restraint is what will make it feel like it belongs in a museum instead of a game.

### A concrete, tasteful visual stack
- **Base:** quiet CARTO Positron, with an optional toggle to a faint georeferenced
  historical-Europe overlay.
- **Optional intro:** a slow globe (MapLibre globe) that settles down into the 2D
  map — used once, as an establishing shot.
- **Journeys:** muted single-accent arcs (deck.gl `ArcLayer`) or self-drawing
  SnakeAnim lines (doc 06).
- **Portraits:** dignified, consistent size, name + dates always visible, subtle
  focus transition — never a decorative collage, never without rights.
- **Motion:** slow eases, no loops, `prefers-reduced-motion` fully honored.
- **Always:** a 2D, low-power, screen-reader-friendly version is the baseline; 3D is
  an enhancement layered on top, never the only way in.

---

## Part B — Comprehensive weakness audit

The honest list of where this plan can fail, roughly worst-first, each with a
mitigation. A good plan names its own failure modes.

1. **Tone / spectacle risk (highest).** The visual ambition can tip the project from
   memorial into edutainment. *Mitigation:* the restraint rules in Part A; run every
   feature through the "understand a person vs. consume their suffering" test; have
   Mr. Masters sign off on tone, not just facts.

2. **Rights & permissions are bigger than "ask Mr. Masters."** Testimony *text* is
   copyrighted; survivor *portraits* carry rights; some survivors or families are
   living and have a stake. *Mitigation:* get written, per-item clearance for any
   photo or quoted passage; default to paraphrase + short excerpts + a link to the
   full entry rather than republishing testimony wholesale; keep a permissions log.

3. **LLM extraction can distort facts.** Using an LLM on Holocaust content risks
   subtle errors or invented detail — and the field is acutely worried about digital
   distortion. *Mitigation:* require every extracted fact to be grounded in a quoted
   span from the source; store that provenance; human-verify before publish; never
   let the model "fill in" what the testimony doesn't say.

4. **The "same camp, same time" claim can be wrong.** Asserting two real people were
   together is a strong factual claim built on often-vague dates, and an error could
   distress a family. *Mitigation:* only surface verified overlaps; show the
   uncertainty; phrase carefully ("both describe being at X around 1944"), never
   "they were together."

5. **Verification labor is large.** Human-reviewing 200 testimonies is a serious
   solo workload that the plan can under-estimate. *Mitigation:* prototype on 5,
   ship, then review in prioritized batches; recruit help (a history class, Mr.
   Masters, volunteers); treat unreviewed entries as "not yet published," not as
   blockers.

6. **Accessibility vs. spectacle conflict.** 3D/WebGL/AR degrades for keyboard,
   screen-reader, low-end-device, and motion-sensitive users — directly against the
   a11y requirement. *Mitigation:* 2D accessible version is the canonical product;
   3D is progressive enhancement with a fallback; test with a screen reader.

7. **Sustainability / bus factor.** A solo student graduates; who maintains it?
   Fancier stacks make this worse. *Mitigation:* favor the simplest stack that
   works; document the handoff (doc 02 §9); keep the data and pipeline reproducible;
   avoid exotic dependencies.

8. **Auto-update fragility.** The pipeline assumes the WordPress structure/REST API
   stays stable; a theme change can break it silently. *Mitigation:* validate in CI
   and fail loudly; alert on zero-results or schema drift; keep the last good dataset
   so the live site never breaks even if a build fails.

9. **Geocoding precision limits.** Some places are ambiguous or unmappable.
   *Mitigation:* a place may be "approximate" or "unknown"; show that honestly rather
   than guessing a pin; keep the as-written name even when you can't place it.

10. **Performance / payload.** 200 markers + portraits + 3D + historical tiles is
    heavy, especially on mobile and limited data. *Mitigation:* clustering, lazy-load
    images, compress, set a performance budget, test on a real mid-range phone.

11. **Scope / time realism.** The full vision is large for a student with AP/IB load.
    *Mitigation:* the prototype-first plan (doc 05); every phase is independently
    shippable (doc 02).

12. **Builder's emotional load.** Months immersed in testimony is genuinely heavy.
    *Mitigation:* pace yourself, talk to people, it's okay to step back. This is real,
    not a footnote.

13. **Dependency risk.** CDNs, Google Sheets, and tile providers can change or vanish;
    this site is meant to last. *Mitigation:* pin versions, self-host critical
    libraries, prefer a generated GeoJSON over a live Google Sheet for production.

14. **Privacy / over-exposure.** Don't surface anything more sensitive in aggregate
    than the archive already shows. *Mitigation:* expose only what's already public;
    no contact details; review the aggregate view with Mr. Masters.

### The three to actually lose sleep over
Tone (1), rights (2), and factual distortion (3/4). Everything else is ordinary
engineering risk with ordinary mitigations. Those three are the ones where getting
it wrong does real harm to real people and to the memory you're trying to honor.

---

## Part C — what changed in the other files
This finalization folded Part A's guidance into `01` (a visual-design section), `03`
(3D/historical-map tools), and `06` (restrained visual upgrades), and added tone +
rights + 2D-fallback guardrails to the build prompts `04` and `07`. This file is the
canonical reference for the *why*; those files carry the *how*.
