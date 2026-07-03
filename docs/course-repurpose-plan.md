# Course repurpose plan — the atom factory

Turn the growth course (`apps/course`) from **11 walls of text** into a **stream of
bite-size, interactive, guilt-free units** — without writing new content and without
building new machinery (the workbook/quiz/video/progress platform already ships).

The framing that governs every decision here: **factory-shaped, not book-shaped.** We are
not chopping a book into smaller book-chunks. We are standing up a *production line* whose
raw material is the existing long MDX + its 30 embedded YouTube videos, and whose output is
many small "productive content" atoms — each a satisfying 1–3 minute loop (read → one
interaction → done-tick → next). Atoms are also the substrate for the two bigger factory
outputs we want later: an **in-course agent** you can talk to about the piece you're on,
and **certification / evaluation** — both of which need atoms, not walls, to work.

Status legend: `[ ]` todo · `[~]` built-to-seam · `[x]` done

---

## 0. Decisions locked (2026-07-03)

- **Split model:** nested — each chapter becomes a folder: a short **hub** page + 6–12
  **mini-articles**, collapsible under the chapter in the sidebar, each with its own
  done-tick. Preserves the `Measure / Keep / Grow / Run` modules and the chapter grouping.
- **Videos:** frame + distill **on-page** — pull the transcript, write a 1–2 line "why
  watch" + 3–5 distilled takeaways, offer a collapsible full transcript. Watch OR read;
  depth either way. This is the "watch & digest" atom.
- **Free scope:** the **whole first chapter** is free (today only the single first lesson
  is). A big, bite-size, obviously-massive top-of-funnel magnet.
- **Pilot:** build the factory on **Chapter 1 (`01-what-is-posthog`)** end-to-end as the
  reference chapter, then apply the same treatment to Chapter 0 (`00-product-led-growth`,
  the literal front door) so the free magnet is the first thing a prospect lands on.

---

## 1. The atom (the unit the factory emits)

One idea, self-contained, **150–500 words / 1–3 min**, ending in a done-tick + "next →".

**Standard anatomy**
1. **Hook** — one or two sentences: what this is and why it matters. (Often the section's
   existing opening lines.)
2. **The idea** — the concept/example/table, trimmed to the single point.
3. **One interactive beat** — exactly one of: a `CheckIn`, a `Flashcards` set, a 1-question
   inline check, or a framed video (never a wall of all four).
4. **Close** — a one-line takeaway; the existing footer supplies "mark done · next →".

**"Watch & digest" variant** (video-first atom)
- 1–2 line "why watch this" → the `VideoEmbed` → 3–5 distilled takeaways (written from the
  transcript) → collapsible full transcript → the existing watched-toggle. Article #4 of
  Chapter 1 (the two PostHog demos) is the canonical example.

---

## 2. Chapter 1 → 10 atoms (the worked reference)

Seams already exist as `##`/`###` boundaries — the author wrote modularly.

| # | slug | atom | carries |
|---|------|------|---------|
| — | `index` | **hub** | "In this chapter" + card-map of the 10 pieces + "watch, then digest" framing |
| 1 | `why-measure` | Why measure at all | `teamSize` check-in |
| 2 | `one-pipeline` | One pipeline, one identity | official 9-min demo (digested) |
| 3 | `the-suite` | The whole suite, one screen | the 11-product list |
| 4 | `two-demos` | The two demos to actually watch | analytics + replay videos (watch & digest) |
| 5 | `events-and-persons` | Events, persons, and why it isn't GA4 | data-model concept |
| 6 | `workflows-vs-hogsend` | PostHog Workflows vs Hogsend | the table + its flashcards |
| 7 | `us-or-eu` | US cloud or EU cloud | the one irreversible decision |
| 8 | `what-it-costs` | What it costs | pricing table + gotchas |
| 9 | `why-posthog` | Why PostHog vs the alternatives | Mixpanel/GA4/Segment + `analyticsStack` check-in |
| 10 | `set-up-account` | Set up your account (do this now) | the 4-step checklist + the chapter quiz |

---

## 3. Structure — Fumadocs nesting

```
content/courses/growth-with-posthog/
  meta.json                        # module separators; chapter entries become folder refs
  01-what-is-posthog/
    meta.json                      # { "pages": ["index", "01-why-measure", … "10-set-up-account"] }
    index.mdx                      # the hub
    01-why-measure.mdx
    02-one-pipeline.mdx
    …
```

- Ordering stays lexical (numeric prefixes), so `gating.ts` sort and `nextLessonOf()` keep
  working across the deeper slug (`01-what-is-posthog/03-the-suite`).
- Interactive block `id`s are the persistence keys — **moving a block to a new file keeps
  its saved data as long as the `id` is unchanged.** Do not rename ids on the move.

---

## 4. The factory pipeline (repeatable per chapter)

Producing a chapter's atoms is mechanical — this is the line, run it per chapter:

1. **Transcript pull** — `scripts/pull-transcripts.mjs` runs `yt-dlp` over the chapter's
   YouTube ids → `content/.../_transcripts/<id>.md` (auto-captions, cleaned).
2. **Atomize** — split the chapter MDX at its `##`/`###` seams into the folder of
   mini-articles per §2; write the hub `index.mdx`.
3. **Frame videos** — for each embed, add the "why watch" line + 3–5 takeaways (from the
   transcript) + collapsible transcript.
4. **Redistribute interactives** — move each `CheckIn`/`Flashcards`/`WorkbookPrompt` next
   to its idea (ids unchanged); place the quiz on the last atom (`set-up-account`).
5. **Regenerate + verify** — `scripts/generate-workbook-manifest.mjs`, update hard-coded
   counts, `pnpm check-types`, build, eyeball on preview.

---

## 5. Machinery changes (small, enumerated — this is the whole engineering surface)

- [x] **3-level tree / identity** — unified lesson identity on the full sub-path after the
  course (`slugs.slice(1).join("/")`, backward-compatible with flat lessons): manifest
  generator recurses folders (index→folder slug); `nextLessonOf`, `/api/progress`,
  `getCourseModules` (flattens hub + atoms, `depth` field), the overview, and `/workbook`
  all follow it. `decorateTree` already recursed.
- [x] **Quiz placement** — the chapter's full pooled quiz sits on the last atom
  (`10-set-up-account`); its per-lesson key becomes `quiz:<course>/01-what-is-posthog/10-set-up-account`.
- [x] **Gating: whole-first-chapter-free** — `isFreeLesson()` now frees any lesson under a
  `FREE_CHAPTERS` entry (`growth-with-posthog/01-what-is-posthog`), course-scoped, plus the
  lexically-first lesson as before.
- [x] **Hard-coded counts** — no change needed: atomizing preserved every block, so the
  manifest is still 84 items / 110 quiz questions; the "Chapters" fact now counts depth-0
  entries so it stays accurate.
- [x] **Video digest** — added a server-rendered `<VideoTranscript id>` block (collapsible,
  from the committed transcripts JSON — no client bloat, no MDX-escaping); "why watch" stays
  the `VideoEmbed` note and takeaways are authored as a short list. Watched-toggle intact.
- [x] **CheckIn ids** unchanged (`teamSize`, `analyticsStack`), so saved data + `lib/profile.ts` are untouched.

---

## 6. Transcript pipeline detail

- Tool: `yt-dlp --skip-download --write-auto-sub --write-sub --sub-lang en --sub-format vtt`
  per YouTube id (all 30 videos are external YouTube; auto-captions are free + fast).
- Post-process VTT → clean Markdown (strip timestamps/cue tags, de-dup rolling caption
  lines) with a tiny node script; store at `content/.../_transcripts/<id>.md`.
- Transcripts serve two jobs: **source material** for the "why watch / takeaways" copy, and
  the optional **on-page collapsible** transcript (skim-friendly, SEO, ad-blocker-proof
  reading).
- Fallback if a video has no captions: note it in the run log; hand-summarise or drop the
  on-page transcript for that one (still keep the framing).

---

## 7. Rollout

- [x] **Phase 0 — transcript pipeline.** `scripts/pull-transcripts.mjs` + cleaner + committed
  `generate-transcripts.mjs`; run over Chapter 1's 3 videos (1640/891/549 words). Wired into
  prebuild/predev/check-types. (Remaining: run over the other 27 videos with `--sleep-requests`.)
- [x] **Phase 1 — structural spike.** Nested folder + 3-level tree + whole-chapter-free gating,
  `VideoTranscript` block. Verified: build passes, all 5 surfaces render HTTP 200.
- [x] **Phase 2 — finish Chapter 1.** All 10 atoms + hub, whole chapter free, quiz on the last
  atom, manifest still 84 items. Verified rendering locally; **awaiting Doug's preview → merge.**
- [x] **Phase 3 — Chapter 0** (the front door) through the same line: hub + 9 atoms, whole
  chapter free, with **more distributed flashcards + quizzes** (4 decks + a mini-quiz added;
  facts now 88 workbook items / 114 quiz questions). Both free chapters (0 + 1) atomized.
  Remaining: roll chapters 2–10 through the same line (repeatable now).
- [x] **LLM hand-off (added on request).** Every transcript has Copy + Send-to-Claude/
  ChatGPT/Perplexity (branded chips); every lesson has "Copy for LLM". All payloads open
  with a Hogsend brand line (`lib/llm-brand.ts`) so pasting into a model seeds hogsend.com +
  the tagline. Article text comes from `generate-lesson-text.mjs` (JSX stripped, server-fed).
- [ ] **Phase 4 (later, factory-native surfaces).** In-course **agent** ("ask about this
  atom"); **certification / evaluation** track built on the atom-level quiz + workbook.
  Atomization is the prerequisite for both.

---

## 8. Content angles worth exploiting (from Doug's strategy note)

Not structure — copy/positioning to weave into hubs and atoms as we go:

- **Guilt-free productive consumption.** People use AI alone to maximise output; an
  enriching, low-friction, button-clicking learning loop is a legitimately *productive*
  thing to do alone. Every atom should feel like a small win, not homework.
- **"Your business is a part-time data warehouse."** AI adoption's curve is steep and most
  haven't noticed that PostHog puts warehouse-grade measurement within reach of single-digit
  teams. Strong hook for the Measure module.
- **High-leverage decisions → coaching/education demand.** The future of work needs people
  making high-leverage calls more often → thought leadership + certification/evaluation are
  in demand. Points at Phase 4.
