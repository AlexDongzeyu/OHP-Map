# 09 — Finish & Polish: From Deployed Shell to Living Memorial

You shipped something real to the internet, on Cloudflare Workers, with the right
structure and the right tone. That's the hard habit most people never build. This
file is the honest gap analysis plus the step-by-step to close every gap — fixing
the immediate blocker, wiring the auto-updating pipeline natively on Cloudflare, and
adding the visual polish you keep asking for (without tipping into spectacle).

> **Scope of this audit:** I analyzed the live page at your Workers URL. I can see
> what it *renders* (the mode tabs, the credits, the framing copy, the skip link,
> the "0 journeys" counter) but not your repo or JS source. So the "done right" list
> is from observed output, and a few "not done" items are inferred from the empty
> state. Treat the inferred ones as "check this," not gospel.

---

## Where you are right now

### Done right ✅
- **It's deployed and reachable.** Live on Cloudflare Workers. Deploy-first was the
  correct instinct and you nailed it.
- **The information architecture is right.** Guided / Explore / Patterns are all
  present — the three-lens structure from the plan is in place.
- **The tone is right.** "Made with restraint, in memory of those whose journeys
  these are," credits to HandsOnDataViz + Leaflet (BSD-2) + CARTO, and an explicit
  "source of truth: ohp.crestwood.on.ca." You honored the licensing and dignity
  guidance instead of papering over it.
- **Accessibility basics are seeded.** A "Skip to map" link and a proper viewport
  meta are already there. Good foundation.
- **The meta description and framing copy are thoughtful and on-message.**

### Not done / blocking ❌
1. **"0 journeys" — there is no data. This is the one blocker that matters.** The
   shell renders but no survivors load, so there are no dots, no journey lines, no
   Explore, no Patterns, no scrubber content. Everything below Part 1 is secondary
   until this is fixed.
2. **(Infer/verify) the data file is missing, empty, or the fetch path is wrong.**
   Most likely cause of a clean shell with zero records.
3. **No connection to the OHP source yet** — no sync, so nothing updates.
4. **The visual layer is minimal** — default styling, no journey animation, no
   historical overlay, no portraits. This is the "make it impressive" work.

The good news: the expensive, easy-to-get-wrong parts (structure, tone, deploy) are
done. What's left is data and polish, which is the fun part.

---

## Part 1 — Fix the blocker: get real data in

Priority one. Do this before anything else.

### Step 1.1 — Verify your data source (5 minutes, in a browser)
You're pulling from a WordPress site, and you now know its exact shape: survivors
are a custom post type `ohp`, all filed under the taxonomy term
`/ohp-type/holocaust-survivors/`, each at `ohp.crestwood.on.ca/ohp/{slug}/`.

Open these two URLs in your browser:
- `https://ohp.crestwood.on.ca/wp-json/wp/v2/types` — look for an `ohp` entry.
- `https://ohp.crestwood.on.ca/wp-json/wp/v2/ohp?per_page=2` — do you get JSON?

**If you get JSON → Plan A (REST API).** This is the clean path. The custom post
type is REST-exposed and you can pull everything as structured JSON. WordPress caps
results at 100 per page, so paginate with `?per_page=100&page=1`, `&page=2`, … and
read the `X-WP-TotalPages` response header to know when to stop.

**If it redirects to a normal page or 404s → Plan B (scrape).** The CPT wasn't
registered with `show_in_rest`. Fall back to fetching the listing page
`https://ohp.crestwood.on.ca/ohp-type/holocaust-survivors/` (paginate via
`/page/2/` etc.), collect the `/ohp/{slug}/` links, and fetch each entry page.
Same downstream pipeline either way — keep the ingest behind one function so the
rest of your code doesn't care which path fed it.

### Step 1.2 — Hand-build 5 real survivors first (don't wait for the pipeline)
The fastest way to kill "0 journeys" is to put 5 real, verified survivors into your
data file by hand. Here are real Crestwood survivors with places named in their
public bios — **starter extractions to verify against the full testimony before you
publish** (the public summary is a starting point, not the final record):

- **Israel Cohen** — born Lodz, Poland → Lodz Ghetto → Auschwitz → Kaufering →
  liberation → Toronto. `/ohp/` (confirm slug on the site).
- **Judy Cohen** — born Sept 17 1928, Debrecen, Hungary → … → Toronto.
  `https://www.crestwood.on.ca/ohp/cohen-judy/`
- **Martin Baranek** — born Aug 15 1930, Starachowice, Poland → … → Toronto.
- **Felicia Carmelly** — born 1932, Romania → deported to Transnistria → Toronto.
  `https://ohp.crestwood.on.ca/ohp/carmelly-felicia/`
- **Jozef Cipin** — on the run/hiding with partisans → caught by Gestapo →
  Terezín (Theresienstadt) → survived.

Remember the as-written vs. canonical rule: store "Terezín" *and* "Theresienstadt,"
"Lemberg" *and* "Lviv." Put them in `survivors.geojson` using the schema from doc
02. A minimal starter you can paste and extend:

```json
{
  "type": "FeatureCollection",
  "features": [
    {
      "type": "Feature",
      "geometry": { "type": "Point", "coordinates": [19.4570, 51.7592] },
      "properties": {
        "survivor_id": "israel-cohen",
        "name": "Israel Cohen",
        "bio_excerpt": "Born in Lodz, Poland. Survived the Lodz Ghetto, Auschwitz, and Kaufering before liberation.",
        "archive_url": "https://ohp.crestwood.on.ca/ohp/",
        "verified": false,
        "waypoints": [
          { "as_written": "Lodz", "canonical": "Łódź, Poland", "role": "birthplace", "lat": 51.7592, "lng": 19.4570, "date": {"start":"","end":"","precision":"unknown"} },
          { "as_written": "Lodz Ghetto", "canonical": "Łódź Ghetto", "role": "ghetto", "lat": 51.7769, "lng": 19.4490, "date": {"start":"1940","end":"1944","precision":"year"} },
          { "as_written": "Auschwitz", "canonical": "Auschwitz-Birkenau", "role": "camp", "lat": 50.0270, "lng": 19.2030, "date": {"start":"1944","end":"","precision":"year"} },
          { "as_written": "Kaufering", "canonical": "Kaufering (Dachau subcamp)", "role": "camp", "lat": 48.0890, "lng": 10.8700, "date": {"start":"1944","end":"1945","precision":"year"} },
          { "as_written": "Toronto", "canonical": "Toronto, Canada", "role": "resettlement", "lat": 43.6532, "lng": -79.3832, "date": {"start":"","end":"","precision":"unknown"} }
        ]
      }
    }
  ]
}
```

Note `"verified": false` until you've checked it against the testimony. Mark it
`true` only after a human read.

### Step 1.3 — Make the front end actually load it
This is the literal fix for "0 journeys." Debug in this order:
1. Open the live site, open DevTools → **Network** tab, reload. Look for the request
   that fetches your data file (e.g. `survivors.geojson` or `/data/...`). A red
   **404** there is almost certainly your bug — the file isn't where the code looks.
2. Check the **Console** for parse errors (a malformed GeoJSON throws on `JSON.parse`).
3. Confirm your Worker actually **serves** the data file. On Workers, static assets
   need to be configured (assets binding / `[assets]` in `wrangler.toml`, or the
   file has to be fetched from KV/R2 — see Part 2). A common mistake: the file
   exists in your repo but the Worker never routes a path to it.
4. Confirm the loader updates the counter — "0 journeys" should become "5 journeys."

### Step 1.4 — Commit and redeploy
`wrangler deploy`, reload, confirm 5 journeys render with their lines. **Stop and
look at it on your phone.** You've now turned a shell into a real map.

---

## Part 2 — Auto-updating, the Cloudflare-native way

You want it to "route to every Holocaust survivor automatically from the OHP
website." On Workers you don't need GitHub Actions for this — Cloudflare has the two
pieces built in: **Cron Triggers** (run code on a schedule) and **Workers KV** (a
key-value store to cache the result). The pattern is exactly the one Cloudflare
recommends: a scheduled handler refreshes a cache so user requests never hit the
external API directly — faster responses and no rate-limit exposure.

### The architecture
```
Cron Trigger (e.g. daily 06:00 UTC)
   → scheduled() handler in your Worker
       1. fetch the OHP list: /wp-json/wp/v2/ohp?per_page=100&page=N  (paginate)
       2. diff against what's already in KV  → find NEW / CHANGED survivors
       3. unchanged → keep existing verified+geocoded record
          new/changed → extract places (LLM) + geocode → mark verified:false
       4. KV.put("survivors.geojson", mergedData)
fetch() handler
   → serve survivors.geojson straight from KV (instant; no external calls)
```

### Step 2.1 — Create a KV namespace
```
npx wrangler kv namespace create "OHP_DATA"
```
Add the binding to `wrangler.toml`:
```toml
kv_namespaces = [
  { binding = "OHP_DATA", id = "<the-id-it-prints>" }
]
```

### Step 2.2 — Add the cron schedule
```toml
[triggers]
crons = ["0 6 * * *"]   # daily at 06:00 UTC. Cron on Workers is always UTC.
```

### Step 2.3 — Write the two handlers
```js
export default {
  // Runs on the schedule
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(syncSurvivors(env));
  },
  // Serves users from cache
  async fetch(request, env, ctx) {
    const data = await env.OHP_DATA.get("survivors.geojson");
    return new Response(data ?? '{"type":"FeatureCollection","features":[]}', {
      headers: { "content-type": "application/json" },
    });
  },
};

async function syncSurvivors(env) {
  // 1. fetch all pages from the WP REST API (Plan A) or scrape (Plan B)
  // 2. load existing from KV, diff by slug + modified date
  // 3. enrich only the new/changed ones (extraction + geocode)
  // 4. write merged result back
  // await env.OHP_DATA.put("survivors.geojson", JSON.stringify(merged));
}
```

### Step 2.4 — Separate cheap sync from expensive enrichment
Do **not** run LLM extraction + geocoding for all 200 on every tick — it's slow,
costs tokens, and a Worker has limited CPU per invocation. Only enrich survivors
whose slug is new or whose `modified` timestamp changed. Keep a geocode cache in KV
(`geo:Łódź → [51.76, 19.46]`) so a place is never geocoded twice. If enrichment is
heavy, offload it to **Cloudflare Queues** (a cron producer enqueues new slugs; a
consumer Worker drains them with retries) rather than doing it inline.

### Step 2.5 — Keep the human in the loop (this is non-negotiable here)
"Auto-updating" should mean **auto-detected and auto-staged**, not
auto-*published*. New survivors come in as `verified:false`. Two honest options:
- **Stricter (recommended for a memorial):** unverified entries are held out of the
  live map (or shown faintly as "pending review"); the cron logs/emails you the new
  slugs; you read the testimony, confirm the places and dates, flip `verified:true`.
- **Looser:** unverified entries show immediately but clearly labeled "approximate,
  auto-extracted, pending review."

This directly serves doc 08's top risks — rights (#2) and factual distortion (#3).
A wrong pin auto-published about a real person is the failure mode to design out.

### Step 2.6 — Test the schedule locally
```
npx wrangler dev --test-scheduled
# then hit http://localhost:8787/__scheduled to fire scheduled() on demand
```

---

## Part 3 — Make it visually impressive (with restraint)

The "wow" layer. Every item below is chosen to be beautiful *and* appropriate —
read doc 08 first; the rule is restraint reads as respect, and a 2D accessible map
is always the baseline that these enhance.

1. **Quiet basemap + optional period overlay.** Keep CARTO Positron. Add a toggle
   for a faint georeferenced 1930s–40s Europe map (David Rumsey). *How:* a second
   Leaflet `tileLayer` at ~0.4 opacity behind your data, wired to a layer control.
   *Restraint:* accurate cartography only — no grunge, no propaganda styling.

2. **Self-drawing journey lines (the biggest tasteful "wow").** When a survivor's
   chapter opens, their route *creeps* across the map. *How:* Leaflet.Polyline.
   SnakeAnim, `line.snakeIn()`, one muted accent color. *Restraint:* draw instantly
   if `prefers-reduced-motion`.

3. **A gentle globe intro (optional).** A slow globe that conveys the scale of
   displacement, then settles into the 2D map. *How:* MapLibre globe projection used
   once as an establishing shot. *Restraint:* overview only, no fly-throughs, never
   a 3D camp.

4. **Patterns mode = raised journey arcs.** All journeys as thin muted arcs across
   Europe — the aggregate that no alphabetical list can show. *How:* deck.gl
   `ArcLayer` interleaved over MapLibre/Leaflet. *Restraint:* one color, low opacity,
   no animation loop.

5. **Dignified portraits.** A face + name + dates in the side panel, grayscale that
   warms to color on focus, generous whitespace. *How:* a simple CSS transition.
   *Restraint:* one at a time, rights cleared per person, never a collage.

6. **Time scrubber with soft presence.** Dots travel their routes as you drag
   1933–1950. *How:* Leaflet.MovingMarker along each polyline; represent a fuzzy
   date as a soft glow over a *range*, not a hard point. *Restraint:* this is the
   emotional core — keep it slow and quiet.

7. **The connection thread.** When two survivors' verified date ranges overlap at
   one place, draw a thin luminous line between their dots on hover. *Restraint:*
   verified overlaps only; phrase it "both describe being at X around 1944," never
   "they were together."

8. **Typography and space.** A serious serif for names and quotes, a clean sans for
   UI, lots of breathing room, the side panel styled like a page in a book. This
   alone moves it from "student project" to "museum piece."

9. **Micro-interactions.** Slow eases (250–400ms), clear focus rings, a faint
   vignette at the map edges, a single accent color used consistently. No bounce, no
   loop, reduced-motion honored everywhere.

10. **Audio (optional, off by default).** If the OHP has clips, a play button per
    survivor. *Restraint:* never autoplay.

If you do one visual thing this week: **#2 (SnakeAnim journey lines) on your 5
survivors.** Highest impact-to-effort, and it's tasteful.

---

## Part 4 — Sequenced punch list (do in this order)

1. **Verify the REST API** (Part 1.1) — 5 min.
2. **Hand-build 5 survivors → kill "0 journeys"** (1.2–1.4).
3. **Polish the 5-survivor guided view** — SnakeAnim, basemap, type (Part 3 #1,2,8).
4. **Show Mr. Masters** — get written permission + a tone/accuracy sign-off.
5. **Build the Cloudflare cron + KV sync** for the full list (Part 2.1–2.6), staged
   as `verified:false`.
6. **Add extraction + geocoding** for new entries, with the human-review gate.
7. **Build Explore** — clustering (Leaflet.markercluster) + filter bar — on the full
   dataset.
8. **Build Patterns + scrubber + connection thread** (Part 3 #4,6,7).
9. **Accessibility + performance pass** — keyboard, screen reader, mid-range phone,
   lazy-load images, reduced-motion.
10. **One-line embed** for the OHP homepage; hand off with a short README.

---

## Part 5 — Acceptance checks (how to know each piece works)

| Piece | You're done when… |
|-------|-------------------|
| Data loads | The counter shows your real journey count, not "0 journeys" |
| REST/scrape ingest | A script prints all 200+ survivors with their slugs |
| Geocoding | Pins land in the right cities; historical names resolve (Lemberg→Lviv) |
| Cron sync | Publishing a test entry on OHP makes it appear within a day, staged for review |
| Cache serving | The site loads the map with zero external API calls on page load |
| Journey lines | Each survivor's route draws across the map in order |
| Verification gate | No `verified:false` record is presented as fact |
| Accessibility | You can use the whole thing by keyboard and with a screen reader |
| Mobile/perf | It's smooth on a real mid-range phone |

---

## The immediate next move
Open `https://ohp.crestwood.on.ca/wp-json/wp/v2/ohp?per_page=2` right now. JSON or
not, you'll know which data path you're on within 30 seconds — and then Part 1.2
gets you from "0 journeys" to a living map tonight.
