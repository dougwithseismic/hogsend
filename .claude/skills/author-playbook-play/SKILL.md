---
name: author-playbook-play
description: Add a new play to hogsend.com/playbook (apps/docs/content/playbook). Use whenever someone wants a new playbook item — it walks the whole contract end to end - frontmatter, the intro + five-part template in the right register, the copy rules (tool-agnostic play steps, honest facts, valid engine snippets), the dogfood weekly-rotation sync, and the verification gates. The plays shipped in #492 follow this shape.
---

# Author a playbook play

A play is a ~300–600 word micro-play at `apps/docs/content/playbook/<slug>.mdx`,
rendered at `hogsend.com/playbook/<slug>`. It must survive the "is this from
real work?" test — same discipline as the marketing copy register.

## 1. Frontmatter (validated by `source.config.ts` — unknown slugs fail the build)

```yaml
---
title: Imperative, outcome-first (max ~60 chars)
description: One sentence, for meta tags and cards.
hook: The one-line symptom the reader recognizes — present tense, their pain.
category: one of activation | onboarding | retention | revenue | winback | referral | deliverability | measurement (registry: lib/playbook/categories.ts)
personas: [] or a subset of gtm | founders | recruiters | internal | agencies (registry: lib/playbook/personas.ts; empty = everyone)
channels: subset of email | sms | ads | video (registry: lib/playbook/channels.ts) — only channels the play's body actually uses; feeds the filter drawer
tags: [two, or, three]
date: YYYY-MM-DD
timeToResults: honest — "same day", "one week", "2–4 weeks", "ongoing"
---
```

Do NOT set `blueprint:` unless a same-id Journey Blueprint actually exists and
has been verified end-to-end (create via admin API → `hogsend blueprints
list` → `promote --dry-run`). No unverified Installs badges.

## 2. Body structure — intro + the five parts, in this exact order

1. **Intro paragraph** (no heading, right after frontmatter): one or two
   sentences of plain language saying what the play IS. No code, no event
   names, no product names beyond "email".
2. `## When to run it` — the trigger/symptom, who feels it.
3. `## Why it works` — the mechanism. A real number ONLY if we honestly have
   one; never invent statistics. Mechanism reasoning beats fake benchmarks.
4. `## The play` — a numbered list of steps in **general terms**: someone on
   any stack (or no stack) could hand this section to an engineer and get the
   play built. No `event.names`, no Hogsend APIs, no vendor lock. "Track two
   moments", not "emit `setup.step_started`".
5. `## Ship it with Hogsend` — the Hogsend reference implementation. A short
   lead-in sentence, then a `defineJourney()` snippet that would actually
   compile: real API only (`ctx.waitForEvent`, `exitOn`, `entryLimit` +
   `entryPeriod`, `suppress` is required meta, `ctx.guard.isSubscribed()`
   after long waits, distinct `idempotencyLabel` when the same template sends
   twice). Event names live HERE. Cross-link the deeper recipe
   (`/docs/recipes/...`) when one exists.
6. `## How you'll know` — the metric: outcome within a window, framed as a
   funnel/lift the reader can actually build. Link `/docs/conversions/impact`
   where holdout/lift talk earns it.

## 3. Register rules

- Every line a fact (deletion test). Guide-through voice, why-first.
- No hype adjectives, no "unlock", no invented percentages.
- The hook and title must not overlap word-for-word with the intro.

## 4. The install path is the agent prompt — it's automatic

The play page ships a "Copy for your agent" block
(`components/playbook/copy-play-prompt.tsx` + `lib/playbook/prompt.ts`) that
wraps the raw MDX as an implement-this prompt. It reads the file directly —
nothing to wire per play. This is WHY section 4's steps must be
tool-agnostic: the prompt is handed to agents on stacks that aren't Hogsend.

## 5. Sync the weekly rotation

The dogfood repo (`hogsend-dogfood`, sibling checkout) sends one play a week:
`src/journeys/playbook-weekly.ts` holds a hand-synced `PLAYS` array
(slug/title/hook). **Append** the new play there (append-only — never reorder
or remove while enrollments are active; each week is anchored by sleep +
idempotency labels derived from the slug).

## 6. Verify before commit

```bash
pnpm biome check --write apps/docs
pnpm --filter @hogsend/docs check-types
pnpm --filter @hogsend/docs build     # validates frontmatter + MDX
```

Then run the real app (`pnpm --filter @hogsend/docs exec next dev --port
3105` if 3005 is busy) and screenshot the play page AND the index with the
new card — no HTML mockups. Check: intro renders above the numbered 01–05
sections, list markers show, the copy button copies the full prompt.

One commit per play, conventional format, e.g.
`feat(docs): playbook play — <slug>`.
