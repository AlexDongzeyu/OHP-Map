# Crestwood OHP Survivor Map — Project Dossier

This is the planning package for turning the Crestwood Oral History Project (OHP)
archive into an interactive, self-updating map of Holocaust survivor journeys.

The archive lives at **`ohp.crestwood.on.ca`** and runs on **WordPress 6.9.4**,
which is the single most important technical fact in this whole plan: it means you
can pull clean JSON from the WordPress REST API instead of scraping fragile HTML.

## Start here

The prototype is **deployed** (Cloudflare Workers) but currently shows "0 journeys"
— the shell is built, no data is flowing in yet. So the file to act on now is
**`09_finish_and_polish.md`**: it audits the live site, fixes the data blocker
step-by-step, wires the auto-update pipeline natively on Cloudflare (Cron + KV), and
lays out the visual-polish playbook. `05`–`07` remain the reference for the
fork-first strategy and the build prompts; `08` is required reading before the
visual work.

## What's in here

| File | What it's for |
|------|---------------|
| `01_improved_concept.md` | The refined product vision. What it *is*, what's new vs. a plain dot-map, and the design/ethics decisions that make it good. |
| `02_sdlc_plan.md` | The full software development lifecycle: requirements, architecture, risk register, phased milestones, testing, deployment, maintenance, timeline. |
| `03_tools_skills_resources.md` | Every tool/library with *why* it's chosen, the skills to build (mapped to the project), and free learning resources. |
| `04_build_prompt.md` | Copy-paste prompt to drive Claude Code through the **full, from-scratch** build, phase by phase. Use *after* the prototype. |
| `05_prototype_playbook.md` | **The action plan.** Fork-first strategy, a build-vs-reuse decision matrix, a step-by-step weekend prototype, and the migration path to the full product. |
| `06_reuse_toolkit.md` | The forkable base templates and the Leaflet animation plugins (with links + licenses), each mapped to a feature. This is what makes it look great. |
| `07_prototype_prompt.md` | Copy-paste prompt to drive Claude Code through **forking and adapting** the template into the prototype. |
| `08_visual_direction_and_weaknesses.md` | **Read before building anything visual.** Honest triage of the 3D / AR / "WW2" / collage ideas, the tasteful alternatives, and a full weakness audit of the whole plan with mitigations. |
| `09_finish_and_polish.md` | **The live-site action guide.** Audit of the deployed Cloudflare prototype (what's done vs. the "0 journeys" blocker), step-by-step to load real data, the Cloudflare-native auto-update pipeline (Cron + KV), the visual-polish playbook, and a sequenced punch list. |
| `10_references_and_roadmap.md` | World-class inspiration projects (Arolsen TransRem, Stolpersteine, The Pudding, NYT), forkable repositories, the skills to build, and the order to do it in. |
| `11_claude_design_brief.md` | **Paste into Claude Design.** A self-contained brief to produce a beautiful, dignified visual system + screen mockups (landing, guided, explore, patterns, survivor card, empty states). |
| `12_github_copilot_instructions.md` | **Paste into GitHub Copilot.** A self-contained, phased agent prompt: read the repo → research references → critically evaluate → improvement plan → implement smallest-risk-first, with guardrails. |

## Suggested order

1. `05` — decide to fork, understand the strategy.
2. `06` — grab the base template + the journey-animation plugin.
3. `07` — run the prototype prompt in Claude Code; ship the weekend prototype.
4. `08` — before you make it fancy, read the visual-direction triage + weakness audit.
5. `01` / `03` — absorb the full vision and the skills while the prototype is live.
6. `02` / `04` — build the pipeline and the custom Explore/Patterns/scrubber views.

## The one-paragraph version

A first-time visitor lands in a **guided scrollytelling intro** that walks them
through one survivor's journey — the map pans and draws the route as they scroll.
They then enter **Explore mode**: every survivor is a dot at their hometown on a
quiet, desaturated basemap; click one and a side panel opens with their bio, a
journey line (hometown → ghettos/camps → liberation → Toronto), and a link to
their full archive page. Click a camp like Auschwitz and every Crestwood survivor
connected to it lights up. A **Patterns mode** and a **time scrubber** reveal what
no one reading 200 alphabetical entries can see — including survivors who were in
the same camp at the same time. WordPress stays the content backend; an automated
pipeline rebuilds the map whenever a new survivor is published, with zero manual
work.

## Non-negotiables (read before building anything)

1. **Get Mr. Masters' explicit written OK** before you hit the API or scrape, and
   confirm there is nothing sensitive about presenting this data in aggregate.
2. **Human-in-the-loop before publish.** No extracted place, date, or "two people
   were in the same camp" claim goes live without a person confirming it. On this
   subject matter a confidently-wrong pin is worse than a missing one.
3. **Show uncertainty honestly.** Vague testimony dates stay vague in the data.
4. **Tone over flash.** Restraint is the aesthetic. No 3D camp reconstructions, no
   AR, no "war"-styled grunge, no decorative face collages. Beautiful through
   stillness and accuracy, not spectacle (see doc 08).
5. **Rights before publish.** Only use photos and quotes you're cleared to use;
   prefer dignified one-at-a-time portraits and short excerpts that link back to the
   full archive entry.
6. **2D first.** An accessible, low-power 2D map is the real product; any 3D or
   imagery is an enhancement with a fallback.
