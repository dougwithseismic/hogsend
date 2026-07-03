---
name: atomize-course-chapter
description: Convert a long, flat course chapter (a single wall-of-text `.mdx`) into a nested hub + a stream of bite-size interactive "atoms" in apps/course (Next.js + Fumadocs). Use this when someone wants to atomize a chapter — or a whole course — of growth-with-posthog: it walks the proven "atom factory" pipeline end to end (pull transcripts → snapshot the block inventory → split into hub + atoms per the authoring contract → delete the flat file → regenerate + verify the manifest hasn't drifted → run gates → one commit per chapter). Reproduces chapters 0 and 1, which already ship in this shape.
---

# Atomize a course chapter (the atom factory)

Turn **one flat chapter** (`content/courses/growth-with-posthog/NN-slug.mdx`, a long wall of
text) into a **nested folder**: a short **hub** page + 6–12 **bite-size atoms**. The pattern
already ships for chapters `00-product-led-growth` and `01-what-is-posthog` — **your output
must be indistinguishable in shape from those**. Read them before you start.

**Factory-shaped, not book-shaped.** You are not chopping a book into smaller book-chunks —
you're running a production line. Raw material = the existing long MDX + its embedded YouTube
videos. Output = many small atoms, each a satisfying **1–3 minute loop**: read one idea → one
interaction → done-tick → next. Atoms are also the substrate for the planned in-course agent
and certification, which need atoms not walls. **You do not write new content** and **you do
not build machinery** — the workbook/quiz/video/progress platform already ships.

## Preconditions & where things live

- Work from **`apps/course`** (all commands below assume `cd apps/course`). App = Next.js +
  Fumadocs; dev server runs on **port 3006**.
- Course content: `content/courses/growth-with-posthog/`. A flat chapter is `NN-slug.mdx`; an
  atomized chapter is a folder `NN-slug/` with `index.mdx` (hub) + `meta.json` + `NN-atom.mdx`.
- Reference chapters to imitate: `00-product-led-growth/` and `01-what-is-posthog/`.
- The authoring contract this skill enforces (verbatim source): read
  `01-what-is-posthog/{index.mdx,meta.json,01-why-measure.mdx,04-two-demos.mdx,10-set-up-account.mdx}`
  as the canonical examples of a hub, a CheckIn atom, a two-video atom, and the final atom.
- `yt-dlp` must be on PATH for transcript pulls.
- Lesson identity in the app is `slugs.slice(1).join("/")` — so atom
  `NN-slug/MM-atom.mdx` is the lesson `NN-slug/MM-atom`, and `index.mdx` collapses to the
  chapter slug `NN-slug` (Fumadocs strips `index`). The numeric `NN-`/`MM-` prefixes make
  sidebar order == reading order == manifest DFS order.

---

## The pipeline — per chapter, in order

### 1. Pull transcripts

```bash
cd apps/course
node scripts/pull-transcripts.mjs        # scans ALL course MDX, pulls MISSING transcripts
node scripts/generate-transcripts.mjs    # bundles content/transcripts/*.md -> lib/transcripts.generated.json
```

`pull-transcripts.mjs` needs `yt-dlp` on PATH and hits YouTube, which **rate-limits (HTTP
429)** — a per-video failure is logged and skipped, never fatal. **Re-run to fill gaps.** To
force specific ids: `node scripts/pull-transcripts.mjs <id> <id>`. You need a transcript for
every `<VideoEmbed id="…">` in the chapter before you write its "watch & digest" digests.

### 2. Snapshot the block inventory (your verification baseline)

Before touching anything, record the chapter's current interactive-block keys. This is the
safety net for step 6 — atomizing **relocates** blocks across files but must not **change**
their ids/counts.

```bash
# Sorted list of every interactive-block key for the chapter (save it as the baseline).
node -e 'const m=require("./lib/workbook-manifest.generated.json");const ch=process.argv[1];const c=m["growth-with-posthog"]||{};const keys=Object.entries(c).filter(([k])=>k===ch||k.startsWith(ch+"/")).flatMap(([,items])=>items.map(i=>i.key)).sort();console.log(keys.join("\n"))' 02-aarrr-and-the-leaky-bucket > /tmp/atoms-baseline.txt
cat /tmp/atoms-baseline.txt
```

(Swap `02-aarrr-and-the-leaky-bucket` for your chapter slug.) Keys look like
`profile:teamSize`, `media:WPjJLpNxI6s`, `checklist:…`, `note:…`, `flashcards:cards-posthog`,
`quiz:growth-with-posthog/NN-slug`. Note the **quiz key is path-derived** — it will legitimately
change when the flat file becomes a nested folder (see step 6). Every **id-keyed** block
(`profile`/`media`/`checklist`/`note`/`flashcards`) must survive the move unchanged.

### 3. Split the flat chapter into hub + atoms (the authoring contract)

Create `content/courses/growth-with-posthog/NN-slug/` and write `meta.json`, `index.mdx`, and
one `NN-atom.mdx` per atom. Rules (summarized from the atom contract — the reference chapters
are the ground truth):

- **Seams = `##` (h2) sections. One atom per `##` by default.** Merge two tiny adjacent
  sections (each a single paragraph) into one atom; split one overlong section that clearly
  holds two separable ideas. **Target 6–12 atoms.** `###` subsections stay INSIDE their parent
  atom. Preserve original order.
- **Atom slugs** are short, kebab-case, describe the *idea* (not "section-2-3"): `## 2.3
  Activation and the aha moment` → `03-activation-aha.mdx`.
- **Prose**: keep the author's voice and facts — trim each section to its single point, lightly
  tighten transitions that referenced neighbouring sections, but **do NOT rewrite or summarise
  the substance**. Keep tables, code blocks, lists intact.
- **Interactive blocks — COPY VERBATIM (highest-risk rule).** `<CheckIn>`, `<Flashcards>`,
  `<Quiz>`, `<WorkbookPrompt>`, `<Checklist>`, `<VideoEmbed>`, `<PodcastLink>` are
  persistence-keyed by their `id` (Quiz by lesson path). Copy each block
  **character-for-character** from the source — every `id`, every entry in a
  `cards={[…]}`/`questions={[…]}`/`options={[…]}`/`items={[…]}` array, every attribute. **Never**
  rename an id, reword a card, add/remove/reorder an array entry, or reformat props. Changing
  anything silently orphans a reader's saved answer or changes the counts the app displays.
  When in doubt, extract the exact source substring and paste it. Place each block in the atom
  carrying its idea. **The `<Quiz>` goes on the final atom.**
- **Video treatment ("watch & digest").** For every `<VideoEmbed id="XXXXXXXXXXX" …/>`:
  1. Keep the `<VideoEmbed>` exactly as-is.
  2. On the very next line add `<VideoTranscript id="XXXXXXXXXXX" />` (same id) — the server
     component that renders the on-page collapsible transcript + Copy/Claude/ChatGPT/Perplexity
     buttons. You do NOT author those buttons.
  3. Then a short distilled digest (read `content/transcripts/XXXXXXXXXXX.md` for real,
     specific takeaways — match the tone in `04-two-demos.mdx`):
     ```
     **What to take from it:**

     - <takeaway 1 — a genuine point from the video>
     - <takeaway 2>
     - <takeaway 3 (optional)>
     ```
  `<PodcastLink>` gets **NO** `<VideoTranscript>` and **NO** digest — copy it verbatim, leave it.
- **Final atom** = the chapter's concluding section (its "Before you move on" / summary). It
  carries the **`<Quiz>`** and the **`## Go deeper`** list — move both there verbatim.
- **Do NOT author** `<LlmActions>` / "Copy for LLM" / `<ChapterWorkbook>` — the lesson page
  (`app/learn/[[...slug]]/page.tsx`) injects those automatically per lesson.
- **Do NOT** edit the top-level `content/courses/growth-with-posthog/meta.json`.

**Atom anatomy** — each `NN-atom.mdx`:

```mdx
---
title: "Short human title for THIS idea (not the chapter title)"
description: "One or two sentences: what this is and why it matters. Used as meta description + sub-header."
workbook: "Only if this atom carries a CheckIn/WorkbookPrompt/Quiz/Flashcards/Checklist/VideoEmbed/PodcastLink. One line on what the reader captures/does here."
---

<prose: the section body, trimmed to its single point — author's voice and facts intact>

<interactive block(s) that belonged to this section — COPIED VERBATIM>
```

Include `workbook:` **only** when the atom has an interactive block (`01-why-measure.mdx` omits
it; `04-two-demos.mdx` and `10-set-up-account.mdx` include it).

**Hub `index.mdx`** — model on `01-what-is-posthog/index.mdx`:

```mdx
---
title: "Chapter N — <original chapter title>"
description: "<reuse/lightly-adapt the original chapter description; end with '… in <count> short pieces.'>"
workbook: "<reuse the original chapter's workbook: frontmatter verbatim if it had one>"
---

> **In this chapter:** <reuse the original chapter's opening '> **In this chapter:**' blockquote — it already exists at the top of the flat file>

**How this chapter works.** It's broken into <count> short pieces — most are a one- to
three-minute read. <one sentence on the video treatment if the chapter has videos>. Work
through them in order, or jump to what you need:

1. [<atom 1 title>](./01-kebab) — <half-line hook>.
2. [<atom 2 title>](./02-kebab) — <half-line hook>.
…
```

Reuse the original chapter's `title`/`description`/`workbook` frontmatter and the existing
top-of-file blockquote — **invent no new claims**. Link every atom in order with a half-line hook.

**`meta.json`** — model on `01-what-is-posthog/meta.json`:

```json
{
  "title": "Chapter N · <2–4 word short name>",
  "pages": ["01-kebab", "02-kebab", "…", "NN-final"]
}
```

List every atom slug in order. **Do NOT list `index`** (Fumadocs shows the folder as the hub).

### 4. Delete the flat file

```bash
git rm content/courses/growth-with-posthog/NN-slug.mdx
```

### 5. (Only for give-away chapters) make the whole chapter free

If the entire chapter is a top-of-funnel magnet, add its `course/chapter` key to
`FREE_CHAPTERS` in `lib/gating.ts` (default is only the course's first lesson is free):

```ts
const FREE_CHAPTERS = new Set<string>([
  "growth-with-posthog/00-product-led-growth",
  "growth-with-posthog/01-what-is-posthog",
  "growth-with-posthog/NN-slug",   // ← add
]);
```

Skip this for paid chapters.

### 6. Regenerate + VERIFY (the manifest is your net)

```bash
node scripts/generate-workbook-manifest.mjs \
  && node scripts/generate-transcripts.mjs \
  && node scripts/generate-lesson-text.mjs
```

`generate-workbook-manifest.mjs` **THROWS on any interactive block it can't parse** (missing
required attr, non-array `cards`/`items`, etc.) — a throw here is the net catching a
malformed copy-paste, not a nuisance. Fix the block and re-run.

Then diff the chapter's block keys against the step-2 baseline:

```bash
node -e 'const m=require("./lib/workbook-manifest.generated.json");const ch=process.argv[1];const c=m["growth-with-posthog"]||{};const keys=Object.entries(c).filter(([k])=>k===ch||k.startsWith(ch+"/")).flatMap(([,items])=>items.map(i=>i.key)).sort();console.log(keys.join("\n"))' NN-slug > /tmp/atoms-after.txt
diff /tmp/atoms-baseline.txt /tmp/atoms-after.txt
```

Expected diff: **only the `quiz:` line changes** — its path suffix moves from
`quiz:…/NN-slug` to `quiz:…/NN-slug/MM-final` (the quiz is path-keyed and now lives in the
final atom). Every **id-keyed** block (`profile`/`media`/`checklist`/`note`/`flashcards`) must
be **byte-identical** — any add/drop/rename there means you changed a block; go fix it.

**If you deliberately ADDED blocks** (rare — this is a repurpose, not a rewrite), bump the
hard-coded counts in `FLAGSHIP_CONTENT_FACTS` in `lib/courses.ts`
(`quizQuestions`, `workbookItems`) to match the new totals. If you added nothing, leave them.

### 7. Gates

```bash
pnpm --filter @hogsend/course check-types    # runs all 3 generators + fumadocs typegen + tsc
```

Then a render check — start the dev server and fetch the hub + a few atoms for HTTP 200:

```bash
pnpm --filter @hogsend/course dev            # serves on :3006 (predev re-runs the generators)
# in another shell:
curl -so /dev/null -w "%{http_code}\n" http://localhost:3006/learn/growth-with-posthog/NN-slug
curl -so /dev/null -w "%{http_code}\n" http://localhost:3006/learn/growth-with-posthog/NN-slug/01-kebab
curl -so /dev/null -w "%{http_code}\n" http://localhost:3006/learn/growth-with-posthog/NN-slug/MM-final
```

`build` (`pnpm --filter @hogsend/course build`) is the fuller gate if you want it — `prebuild`
re-runs the three generators too.

### 8. Commit (one commit per chapter)

Conventional commit, e.g.:

```bash
git add -A
git commit -m "feat(course): atomize chapter N into bite-size lessons"
```

**Do NOT push. No co-author. No tool/marketing mentions in the message.**

---

## Parallelize across chapters

Chapters are **independent** — each is a disjoint folder, and atomizing one never touches
another's files. So you can **fan out one subagent per chapter**, each handed this skill + the
atom contract, all splitting in parallel (step 3 is the bulk of the work and is embarrassingly
parallel). Keep the **regenerate + verify + commit** steps (6–8) **central/serial** so the
generated manifests (`lib/*.generated.json`) don't race, and so each chapter lands as its own
clean commit. Steps 1–2 (transcript pull + baseline snapshot) can run once up front for the
whole course.

---

## Gotchas

- **Interactive block ids are persistence keys.** Never rename, reword, reorder, or drop an
  array entry in a `<CheckIn>`/`<Flashcards>`/`<Quiz>`/`<WorkbookPrompt>`/`<Checklist>` — you
  silently orphan a reader's saved answer or change the item counts the app renders. Copy the
  exact source substring.
- **The manifest generator THROWS on bad blocks — that's the safety net,** not an obstacle. A
  throw means a malformed/incomplete block copy; the parse error names the file + attr.
- **The quiz key is path-derived** (`quiz:<course>/<lesson>`), so moving the quiz into the
  nested final atom changes its key — expected and fine for a not-yet-nested chapter. Only the
  `quiz:` line should differ in the step-6 diff.
- **`<PodcastLink>` gets no transcript and no digest** — it's not a video; copy it verbatim.
- **The lesson page auto-injects** the LLM buttons ("Copy for LLM" `<LlmActions>`) and
  `<ChapterWorkbook>` per lesson — atoms must NOT author them.
- **`<VideoTranscript id>`** must use the *same* 11-char YouTube id as its `<VideoEmbed>`; it
  renders nothing if no transcript exists for that id (so step 1 must succeed first).
- **Lesson identity is `slugs.slice(1).join("/")`** and the manifest key mirrors it (numeric
  prefixes retained; `index` collapses to the folder). Don't rename atom files after readers
  have progress — the slug is the progress key.
- **Don't edit the top-level course `meta.json`** or write summary markdown / leave TODOs.
