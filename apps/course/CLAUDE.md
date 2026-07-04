# apps/course — authoring guide for course content

This file is the writing contract for `content/courses/growth-with-posthog/`. It exists
because the course was once half-good: chapters 0–1 read like a sharp colleague talking
you through the material, while later chapters read like a book fed through a wood
chipper — bullet dumps, course-logistics openers, and sentences pointing at code blocks
that live in other files. Everything below is extracted from what the good chapters
actually do. **Before writing or rewriting any atom, read three atoms of
`00-product-led-growth/` and `01-what-is-posthog/` — they are the bar.**

Structure/mechanics of atomizing a chapter (hub + atoms, manifest, gates) live in the
`atomize-course-chapter` skill. This file is about the prose.

## The one-paragraph version

Each atom teaches ONE idea in 3–6 flowing paragraphs, opens with a flat assertive claim
about the subject (never about the course), defines every new term the moment it
appears, argues in prose and only enumerates in lists, ends on an aphorism or a
content-named handoff, and works read cold, standalone, by someone who has read nothing
else. Course-navigation talk lives ONLY in the hub `index.mdx`.

## Voice

- **Subject-first openings.** The first sentence is a flat, assertive claim about the
  subject: "The tools in this course — PostHog, Hogsend, a Meta pixel — are the easy
  part." Never about the chapter's position, reading order, or what the section will
  cover. Three opening moves cover everything: the flat claim, the fact-with-provenance
  ("The term was popularised around 2016 by the VC firm OpenView"), or picking up the
  previous atom's closing thread as a premise.
- **Long build, short verdict.** A clause-stacked sentence followed by a short one:
  "Sales added to a product that can't activate users just industrialises the leak."
  The signature move is the **"X, not Y" contrast pair**: "It's a hat, not a hire."
  "Directional, not destiny." Every atom should land at least one.
- **Prose argues, lists enumerate.** The core claim is made in flowing paragraphs
  FIRST. A list appears only after a prose sentence earns it, and only for genuinely
  enumerable content. Each bullet is a mini-paragraph: **bolded lead phrase** + em-dash
  + 1–3 complete sentences. Never let bullets carry the whole teaching.
- **Evidence woven, not footnoted.** Sources get a one-clause credential inline
  ("Elena Verna — who ran growth at Miro, Dropbox and Amplitude — has the practical
  version") and the link text is the claim itself, not "here" or "this article".
- **Numbers carry a consequence.** "~4× smaller", "$200M ARR within a year with a team
  in the dozens". Never a bare number.
- **Honesty is the register.** Caveats delivered proudly, not buried: "the honest
  answer is yes, with selection-bias caveats". Anticipate the reader's objection and
  answer it in second person: "So if you're wondering whether you're too small for
  this — you're not."
- **Invitational, never drill-sergeant.** "It's worth pausing on…", "three things worth
  settling", "consider writing one line on why". No barked imperatives, no scolding,
  no re-litigating earlier chapters as warnings.
- **Italics stress exactly one pivotal word per sentence. Bold is reserved for the
  atom's one or two load-bearing claims** plus bullet leads. British spellings
  (behavioural, popularised, recognise).

## New terms and jargon (the glossary rule)

A reader new to growth must never hit a term the chapter doesn't cash out.

- **Define at the moment of first use**, in the same sentence, bold + plain-English
  parenthetical + named example, all within two sentences: "Everything in PostHog hangs
  off **events** (a thing that happened) attached to a **person** (who it happened to).
  'User signed up', 'project created', 'page viewed' — each is an event…"
- **Expand every acronym on first use in each chapter**: AARRR (Acquisition, Activation,
  Retention, Referral, Revenue), CAC (customer-acquisition cost), MRR, LTV, NPS, CDP,
  UTM, ROAS, EMQ… Chapters are read out of order; "it was expanded two chapters ago"
  doesn't count.
- **Cash out vague industry words into a measurable**: "'Activated' stops being a vibe
  and becomes `project_created` fired within seven days of signup."
- **Jargon-heavy chapters get a mini-glossary on the hub** — a short "Words you'll meet
  in this chapter" list in plain MDX (term — one-line gloss), after the atom map. Use it
  when a chapter introduces roughly four or more new terms (dunning, holdout, cohort,
  identity graph…). Inline definition on first use is still required; the hub list is a
  landing aid, not a substitute.
- Course coinages ("the dashboard graveyard", "the tactic collector", "the rented-
  audience trap") are bolded once, defined by a one-line scene, then reused as shared
  vocabulary.

## Standalone chapters (the cross-reference rule)

Every chapter must work read cold. The test: a reader landing here first should never
feel they missed required reading.

- **Cross-refs are trailing promises, never load-bearing.** A reference rides in a
  parenthetical attached to a substantive claim made HERE, pointing forward to where an
  idea deepens: "(the instrumentation chapter turns this into a full event taxonomy)".
  The claim is never outsourced to the reference — if the sentence collapses without
  the other chapter, teach the idea here in one clause instead.
- **Point by content, not bare number.** "the lifecycle chapter", "the daily-dashboard
  chapter" — or an actual link. The sidebar was reordered and partially de-numbered;
  bare "Chapter 9" pointers rot.
- **Never open an atom with a cross-reference,** and never use one as a warning lecture
  ("if your retention still decays, go back to Chapters 5–6 first").
- **Never reference the atom stream's own mechanics.** No "the next code block", "the
  journeys above", "as we saw earlier" — atoms get reordered and split; those danglers
  are how the course rotted the first time. "The next piece is…" is allowed only as the
  final handoff sentence, describing content: "The next piece is three minutes of each
  one working."
- The hub `index.mdx` owns ALL course-map talk: the "> **In this chapter:**" blockquote,
  "How this chapter works", the numbered atom map with one-line hooks.

## Atom anatomy

- **One idea per atom**, stated in the title as a claim, restated in a full-sentence
  frontmatter `description` that is a miniature of the atom (not keywords).
- 3–6 prose paragraphs of ~60–110 words. The atom's spine is prose; components are
  guests that arrive after the argument is complete.
- **Tables** only for genuine two-axis comparisons, sandwiched: a prose sentence
  before, a crystallizing one-liner after.
- **Endings land.** Either an aphorism ("The tactics shift by type; the operating model
  doesn't.") or a forward handoff naming the next piece by content. Never end inside a
  bullet, on a resource-link dump, or on a component with no closing prose.
- **Components come last** (CheckIn/Flashcards/Quiz after the prose argument, never
  interrupting it mid-atom). Flashcard/quiz answers are written in the course voice —
  full contrast-pair sentences — and only test what the prose actually taught.
- **The video contract:** one prose sentence earns the video → `<VideoEmbed>` (its
  `note` says who the speaker is and why it's worth the minutes) → `<VideoTranscript>`
  → "**What to take from it:**" with 2–3 single-sentence conclusion bullets (no comma-
  list inventory dumps). Two videos in one atom need a prose bridge between them.

## Banned moves (each of these shipped once; never again)

1. Course-logistics openers: "A gentle reminder on order before anything else: this
   chapter is deliberately seventh."
2. Managing the reader's experience instead of teaching: "The rest of this chapter
   reads differently depending on where you're starting from…"
3. Pointing at other files' mechanics: "A warning before the next code block" (the code
   block lived in a different atom).
4. Bullet-dumping the thesis: "The practitioners' consensus compresses to:" + the whole
   argument as bullets.
5. Stacked components with no prose bridge (video → digest → video → digest).
6. Interactive component dropped mid-atom, chopping the argument in half.
7. Endings without a landing.
8. Cross-reference as scolding, or as the atom's opening.
9. Undefined jargon and unexpanded acronyms.
10. Throat-clearing deferrals: "One more thing before the definitions." "It's worth
    pausing on your current mix before the tactics."

## Hard mechanical rules (readers have saved state)

- **Interactive blocks are persistence-keyed. Copy them byte-identical** when moving or
  rewriting prose around them: every `id`, every entry in `cards`/`questions`/
  `options`/`items`, every attribute. Renaming an id or rewording an option orphans real
  readers' saved answers. Prose-only rewrites must produce an EMPTY workbook-manifest
  key diff.
- **Atom filenames are progress keys.** Never rename an existing atom file.
- Frontmatter `workbook:` only on atoms that carry an interactive block.
- Don't edit the top-level `content/courses/growth-with-posthog/meta.json`; don't
  author `<LlmActions>` or `<ChapterWorkbook>` (the lesson page injects them).

## Verify before committing

```bash
cd apps/course
node scripts/generate-workbook-manifest.mjs   # THROWS on malformed blocks
# key diff vs pre-edit snapshot must be empty for prose-only edits
pnpm --filter @hogsend/course check-types
# residue sweep — should return nothing:
grep -rniE "next code block|above journeys|journeys above|gentle reminder|before anything else|as chapter [0-9]+ put it|deliberately (first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)" content/courses/
```

One commit per chapter, conventional message, no push without say-so.
