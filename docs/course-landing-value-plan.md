# Course landing: value-led selling page (flagship + catalog)

Doug's brief (2026-07-06, voice note): the flagship landing page
(course.hogsend.com/growth-with-posthog) reads like an LLM wrote it — every
card headline is a count ("31 quizzes, 214 questions", "160 flashcards in 15
decks"). Stop selling numbers; sell the value a specific reader gets. Add
audience sections (founders / consultants / people breaking into growth), real
reader quotes (Will's), and an "expense it" section modelled on ctxdc.com's
manager-email block. Both the catalog home page and the flagship page get the
treatment.

Constraints settled at planning time:

- **Testimonials must be real.** Doug has ONE real early reader, Will, whose
  feedback was: "I can see some real value in here. There is a ton of content —
  I'm quite shocked that it's so free. The first two chapters were amazing."
  We do NOT fabricate quotes from invented people (deceptive, FTC territory).
  Instead: split Will's real feedback into attributed pull-quotes ("Will —
  early reader") and carry the rest of the social-proof load with value/benefit
  copy and the existing third-party benchmarks. The section component takes a
  data array so more quotes drop in as they arrive.
- **De-number ≠ delete numbers.** `FLAGSHIP_CONTENT_FACTS` stays the single
  source of truth; numbers move from headlines to supporting clauses. Headlines
  say what the thing does for you.
- **Copy register** (memory feedback): every line a fact, headings as labels,
  no copywriting "moves"; course voice per apps/course/CLAUDE.md (contrast
  pairs, British spellings, no drill-sergeant).
- **Expense-it**: copy-to-clipboard manager email (CopyButton exists). Claims
  in the email must be TRUE for this course ($49, first two chapters free,
  lifetime access, invoice at checkout, gift codes for team copies). No
  invented enrollment counts. Team/group deals beyond the existing gift flow =
  external seam (mailto hello@hogsend.com).

Status legend: `[ ]` todo · `[~]` built-to-seam · `[x]` done

## Phase 1 — Flagship landing (`apps/course/app/(catalog)/[course]/page.tsx`)

- [x] **F1. Value-led copy pass** — rewrite INSIDE_CARDS titles/descriptions to
  lead with the benefit (numbers demoted to clauses); rework the StatBand into
  a value-led band (at most quiet supporting numbers); soften the workbook
  receipt framing. No new components; facts still derived.
- [x] **F2. "Who this is for" section** — three cards: technical founders
  (run your own growth without hiring for it), consultants (a repeatable
  playbook + the artefacts to sell the engagement), people breaking into
  growth (the vocabulary, the calculators, the portfolio-ready plan). Each
  card: what you walk away with, phrased as outcomes. New shared component or
  local data + existing Card/FeatureCard.
- [x] **F3. Reader quotes section** — `ReaderQuotes` ds component (data-driven)
  rendering Will's real pull-quotes with honest attribution; placed after the
  benchmarks. No invented people.
- [x] **F4. "Expense it" section** — pre-written manager-approval email in a
  copyable block (CopyButton), section copy about unused L&D budgets, FAQ item
  updated to mention it; team copies line pointing at the existing gift flow;
  group licensing beyond that = mailto seam.

## Phase 2 — Catalog home page (`apps/course/app/(catalog)/page.tsx`)

- [x] **F5. Catalog alignment** — same de-numbering pass on the catalog
  INSIDE_CARDS + stat band; add the reader-quotes strip; audience line in the
  method/manifesto area; link to the flagship expense-it section.

## Quality gates (run per feature)

```bash
pnpm --filter @hogsend/course check-types
pnpm exec biome check apps/course        # lint + format (biome, not eslint)
pnpm --filter @hogsend/course build      # full next build (also at phase end)
```

Manual check: `pnpm --filter @hogsend/course dev` (port 3006) and eyeball
`/growth-with-posthog` and `/`.

## Seam asks (running list)

- Team/group licensing (bulk codes, invoicing a team) beyond the existing
  one-at-a-time gift flow: needs a decision + possibly Stripe quantity
  checkout. Expense-it section links `mailto:hello@hogsend.com` for now.
- More real testimonials: as they arrive, append to the quotes data array.
