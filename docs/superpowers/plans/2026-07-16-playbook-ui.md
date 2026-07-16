# Playbook UI (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the `/playbook` hero surface in `apps/docs` — searchable, filterable card grid of micro-plays plus the five-part play detail page — with 12 skeleton MDX plays (issue #492, UI phase).

**Architecture:** Mirror the `/articles` pipeline: a `playbook` fumadocs-mdx collection with a strict Zod frontmatter schema, a typed `lib/playbook/` loader with build-failing registries for categories/personas, server pages that serialize a light play index into a client `PlaybookExplorer` for instant filtering (URL-synced). Detail pages render MDX through the existing component map with playbook-scoped prose CSS.

**Tech Stack:** Next.js 15 app router, fumadocs-mdx collections, Tailwind (dark crimzon ds primitives in `apps/docs/components/ds`), Biome.

## Global Constraints

- All work happens in the worktree `.claude/worktrees/growth-playbook`, branch `feat/growth-playbook`.
- All paths below are relative to `apps/docs/` unless prefixed otherwise.
- Code style: Biome — 2-space indent, double quotes, semicolons, 80-char width. Typed `JSX.Element` returns, `cn()` from `@/lib/cn`, follow the idioms in `components/articles/*`.
- Conventional Commits, no AI/Anthropic mentions, no co-author lines. Do NOT push.
- `/playbook` is NOT inside the docs tree (no fumadocs docs layout) — it lives in the `(home)` route group like `/articles`.
- Dark crimzon only: page bg `#050101`, white/opacity text tokens, `Section`/`Eyebrow`/`TagPill` primitives. No cover images on playbook cards.
- Verification commands (apps/docs has no vitest): `pnpm --filter @hogsend/docs check-types` and `pnpm --filter @hogsend/docs build`. Run from repo root of the worktree.
- Commit with `--no-verify` only if the pre-push/pre-commit hook hangs on unrelated workspaces (known pnpm reinstall issue); pre-commit biome must still be clean — run `pnpm biome check --write apps/docs` before committing.

---

### Task 1: Playbook collection, registries, loader + 2 seed plays

**Files:**
- Modify: `source.config.ts`
- Create: `lib/playbook/categories.ts`
- Create: `lib/playbook/personas.ts`
- Create: `lib/playbook/index.ts`
- Create: `content/playbook/failed-payment-dunning.mdx`
- Create: `content/playbook/proposal-opened-follow-up.mdx`

**Interfaces:**
- Consumes: fumadocs `defineCollections`, `loader`, `toFumadocsSource` (same as `lib/articles/index.ts`).
- Produces (used by Tasks 2, 4, 5):
  - `CATEGORIES: Record<CategorySlug, { label: string; blurb: string; accent: string }>` and `type CategorySlug` (8 slugs: `activation | onboarding | retention | revenue | winback | referral | deliverability | measurement`), `isCategorySlug(s: string): s is CategorySlug` — from `@/lib/playbook/categories`
  - `PERSONAS: Record<PersonaSlug, { label: string; short: string }>`, `type PersonaSlug` (`gtm | founders | recruiters | internal | agencies`), `isPersonaSlug` — from `@/lib/playbook/personas`
  - From `@/lib/playbook`: `playbookSource` (fumadocs loader, baseUrl `/playbook`), `type Play`, `getAllPlays(): Play[]`, `getRelatedPlays(plays, current, limit?): Play[]`, `type PlayIndexEntry = { url: string; title: string; hook: string; category: CategorySlug; personas: PersonaSlug[]; tags: string[]; installs: boolean; timeToResults?: string }`, `toPlayIndex(plays: Play[]): PlayIndexEntry[]`

- [ ] **Step 1: Add the `playbook` collection to `source.config.ts`**

After the `articles` collection, add:

```ts
export const playbook = defineCollections({
  type: "doc",
  dir: "content/playbook",
  schema: frontmatterSchema.extend({
    /** One-line "when to run it" symptom shown on cards + detail header. */
    hook: z.string(),
    /** Category slug — must exist in lib/playbook/categories.ts. */
    category: z.string(),
    /** Persona slugs — must exist in lib/playbook/personas.ts. Empty = everyone. */
    personas: z.array(z.string()).default([]),
    /** Freeform search keywords. */
    tags: z.array(z.string()).default([]),
    /** Publication date (YYYY-MM-DD; YAML may parse it as a Date). */
    date: z
      .union([z.string(), z.date()])
      .transform((v) => (v instanceof Date ? v.toISOString().slice(0, 10) : v))
      .pipe(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
    /** Blueprint slug — set when the play installs via `hogsend blueprint add`. */
    blueprint: z.string().optional(),
    /** Honest expectation label, e.g. "same day", "one week". */
    timeToResults: z.string().optional(),
  }),
});
```

- [ ] **Step 2: Create `lib/playbook/categories.ts`**

```ts
/**
 * Playbook category registry (the lifecycle-stage axis). Every `category` in a
 * play's frontmatter must be a key here — unknown slugs fail the build via
 * getAllPlays in lib/playbook/index.ts. `accent` is a hex used for the card
 * accent bar / category dot (inline style — not a Tailwind class).
 */
export const CATEGORIES = {
  activation: {
    label: "Activation",
    blurb: "Turn signups into users who felt the value.",
    accent: "#e5484d",
  },
  onboarding: {
    label: "Onboarding",
    blurb: "Get new users to the habit, not just the tour.",
    accent: "#f76b15",
  },
  retention: {
    label: "Retention",
    blurb: "Catch the drop before it becomes churn.",
    accent: "#ffb224",
  },
  revenue: {
    label: "Revenue & expansion",
    blurb: "Plays that move paid conversion and expansion.",
    accent: "#30a46c",
  },
  winback: {
    label: "Winback",
    blurb: "Re-open the conversation with the lapsed.",
    accent: "#0091ff",
  },
  referral: {
    label: "Referral & growth loops",
    blurb: "Let the product's users source the next users.",
    accent: "#8e4ec6",
  },
  deliverability: {
    label: "Deliverability",
    blurb: "Land in the inbox before you optimize anything else.",
    accent: "#05a2c2",
  },
  measurement: {
    label: "Measurement & attribution",
    blurb: "Prove the system moved the metric.",
    accent: "#f0f0f0",
  },
} as const;

export type CategorySlug = keyof typeof CATEGORIES;

export function isCategorySlug(slug: string): slug is CategorySlug {
  return slug in CATEGORIES;
}
```

- [ ] **Step 3: Create `lib/playbook/personas.ts`**

```ts
/**
 * Playbook persona registry (the "browse by role" axis from #492). Every
 * `personas` entry in a play's frontmatter must be a key here — unknown slugs
 * fail the build. `short` is the compact chip label on cards.
 */
export const PERSONAS = {
  gtm: { label: "GTM & marketing teams", short: "GTM" },
  founders: { label: "Founders & sales-adjacent", short: "Founders" },
  recruiters: { label: "Recruiters & talent", short: "Recruiters" },
  internal: { label: "Internal teams", short: "Internal" },
  agencies: { label: "Consultants & agencies", short: "Agencies" },
} as const;

export type PersonaSlug = keyof typeof PERSONAS;

export function isPersonaSlug(slug: string): slug is PersonaSlug {
  return slug in PERSONAS;
}
```

- [ ] **Step 4: Create `lib/playbook/index.ts`**

```ts
import { playbook } from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { type CategorySlug, isCategorySlug } from "./categories";
import { isPersonaSlug, type PersonaSlug } from "./personas";

export const playbookSource = loader({
  baseUrl: "/playbook",
  source: toFumadocsSource(playbook, []),
});

export type Play = ReturnType<typeof playbookSource.getPages>[number];

/** All plays, newest first. Validates category + personas so typos fail the build. */
export function getAllPlays(): Play[] {
  const plays = playbookSource.getPages();
  for (const play of plays) {
    if (!isCategorySlug(play.data.category)) {
      throw new Error(
        `Unknown playbook category "${play.data.category}" in ${play.url}`,
      );
    }
    for (const persona of play.data.personas) {
      if (!isPersonaSlug(persona)) {
        throw new Error(`Unknown persona "${persona}" in ${play.url}`);
      }
    }
  }
  return plays.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** Up to `limit` other plays in the same category, then pads with recents. */
export function getRelatedPlays(
  plays: Play[],
  current: Play,
  limit = 3,
): Play[] {
  const others = plays.filter((p) => p.url !== current.url);
  const same = others.filter((p) => p.data.category === current.data.category);
  const rest = others.filter((p) => !same.includes(p));
  return [...same, ...rest].slice(0, limit);
}

/** The light, serializable index the client-side explorer filters over. */
export type PlayIndexEntry = {
  url: string;
  title: string;
  hook: string;
  category: CategorySlug;
  personas: PersonaSlug[];
  tags: string[];
  installs: boolean;
  timeToResults?: string;
};

export function toPlayIndex(plays: Play[]): PlayIndexEntry[] {
  return plays.map((p) => ({
    url: p.url,
    title: p.data.title,
    hook: p.data.hook,
    category: p.data.category as CategorySlug,
    personas: p.data.personas as PersonaSlug[],
    tags: p.data.tags,
    installs: Boolean(p.data.blueprint),
    timeToResults: p.data.timeToResults,
  }));
}
```

- [ ] **Step 5: Create the two seed plays**

`content/playbook/failed-payment-dunning.mdx`:

```mdx
---
title: Recover failed payments before they become churn
description: A three-touch dunning journey off the payment_failed event.
hook: Involuntary churn is eating revenue you already earned.
category: revenue
personas: [founders]
tags: [dunning, stripe, billing]
date: 2026-07-16
blueprint: failed-payment-dunning
timeToResults: same day
---

{/* Draft skeleton — voice pass pending (#492 content phase). */}

## When to run it

You see `payment_failed` events and no follow-up. Placeholder symptom copy —
one short paragraph naming the trigger and who feels it.

## Why it works

Placeholder mechanism copy — why the timing and channel work, with a real
number where we honestly have one.

## The play

1. Placeholder step one.
2. Placeholder step two.
3. Placeholder step three.

## Ship it with Hogsend

```ts
import { days } from "@hogsend/core";
import { defineJourney, sendEmail } from "@hogsend/engine";

export const failedPaymentDunning = defineJourney({
  meta: {
    id: "failed-payment-dunning",
    trigger: { event: "payment_failed" },
    entryLimit: { type: "once_per_period", period: days(30) },
  },
  run: async (user, ctx) => {
    await sendEmail({ to: user.email, template: "dunning-notice" });
    await ctx.sleep({ duration: days(3), label: "dunning-wait" });
  },
});
```

## How you'll know

Placeholder metric copy — the event that proves recovery, e.g. recovered
`payment_succeeded` within 7 days of `payment_failed`.
```

`content/playbook/proposal-opened-follow-up.mdx` — same skeleton body (copy the five h2 sections and placeholder paragraphs verbatim, swap the snippet's journey id to `proposal-opened-follow-up`, trigger event to `link.clicked`), with frontmatter:

```yaml
---
title: Know the moment your proposal gets opened
description: Tracked links inside proposal PDFs, with a follow-up journey off the click.
hook: You sent the proposal three days ago and you're refreshing your inbox.
category: revenue
personas: [founders, agencies]
tags: [proposals, tracked-links, sales]
date: 2026-07-15
timeToResults: same day
---
```

- [ ] **Step 6: Verify types + build**

Run from the worktree root:

```bash
pnpm --filter @hogsend/docs check-types
```

Expected: PASS (fumadocs-mdx regenerates `.source` with the new collection; `collections/server` now exports `playbook`).

Sanity-check the validation actually fails the build: temporarily change `category: revenue` to `category: bogus` in one play, run `check-types` — types still pass (category is a string), so instead run `pnpm --filter @hogsend/docs build` and expect the `Unknown playbook category` throw once Task 2's page calls `getAllPlays()`. For THIS task, just revert the bogus edit and rely on the unit-visible check in Step 4's code review; the throw is exercised end-to-end in Task 2 Step 5.

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write apps/docs
git add apps/docs/source.config.ts apps/docs/lib/playbook apps/docs/content/playbook
git commit -m "feat(docs): playbook content pipeline — collection, registries, loader (#492)"
```

---

### Task 2: `/playbook` index page — hero, explorer, cards

**Files:**
- Create: `components/playbook/play-card.tsx`
- Create: `components/playbook/playbook-explorer.tsx`
- Create: `app/(home)/playbook/page.tsx`

**Interfaces:**
- Consumes: `toPlayIndex`, `getAllPlays`, `PlayIndexEntry` from `@/lib/playbook`; `CATEGORIES`, `CategorySlug`, `isCategorySlug` from `@/lib/playbook/categories`; `PERSONAS`, `PersonaSlug`, `isPersonaSlug` from `@/lib/playbook/personas`; `Section`, `Eyebrow`, `TagPill` from ds.
- Produces: `PlayCard({ play: PlayIndexEntry })` (also reused by Task 4's related grid via `PlayIndexEntry`), `PlaybookExplorer({ plays: PlayIndexEntry[] })` client component.

- [ ] **Step 1: Create `components/playbook/play-card.tsx`**

```tsx
import Link from "next/link";
import type { JSX } from "react";
import { CATEGORIES } from "@/lib/playbook/categories";
import { PERSONAS } from "@/lib/playbook/personas";
import type { PlayIndexEntry } from "@/lib/playbook";
import { cn } from "@/lib/cn";

/**
 * Typographic library card — no cover image, category accent bar on top,
 * title + hook + persona chips + installs badge. Deliberately NOT the
 * articles feed look.
 */
export function PlayCard({
  play,
  className,
}: {
  play: PlayIndexEntry;
  className?: string;
}): JSX.Element {
  const category = CATEGORIES[play.category];
  return (
    <Link
      href={play.url}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-md border",
        "border-white/[0.08] bg-white/[0.015] p-5 transition-colors",
        "duration-200 hover:border-white/15",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ backgroundColor: category.accent }}
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-mono text-[11px] uppercase tracking-[0.06em]"
          style={{ color: category.accent }}
        >
          {category.label}
        </span>
        {play.installs ? (
          <span className="rounded-[3px] border border-accent bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] text-white uppercase tracking-[0.06em]">
            Installs
          </span>
        ) : null}
      </div>
      <h3 className="font-display text-[19px] text-white leading-[1.25] tracking-[-0.02em] transition-colors group-hover:text-white/85">
        {play.title}
      </h3>
      <p className="text-[14px] text-white/55 leading-[1.55]">{play.hook}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
        {play.personas.map((p) => (
          <span
            key={p}
            className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-white/45 uppercase tracking-[0.06em]"
          >
            {PERSONAS[p].short}
          </span>
        ))}
        {play.timeToResults ? (
          <span className="ml-auto text-[11px] text-white/35">
            Results: {play.timeToResults}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Create `components/playbook/playbook-explorer.tsx`**

```tsx
"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { type JSX, useCallback, useMemo } from "react";
import { CATEGORIES, type CategorySlug, isCategorySlug } from "@/lib/playbook/categories";
import { PERSONAS, type PersonaSlug, isPersonaSlug } from "@/lib/playbook/personas";
import type { PlayIndexEntry } from "@/lib/playbook";
import { cn } from "@/lib/cn";
import { PlayCard } from "./play-card";

type Filters = {
  q: string;
  category?: CategorySlug;
  persona?: PersonaSlug;
};

function readFilters(params: URLSearchParams): Filters {
  const category = params.get("category") ?? "";
  const persona = params.get("persona") ?? "";
  return {
    q: params.get("q") ?? "",
    category: isCategorySlug(category) ? category : undefined,
    persona: isPersonaSlug(persona) ? persona : undefined,
  };
}

function matches(play: PlayIndexEntry, f: Filters): boolean {
  if (f.category && play.category !== f.category) return false;
  if (f.persona && !play.personas.includes(f.persona)) return false;
  if (f.q) {
    const q = f.q.toLowerCase();
    const haystack = [play.title, play.hook, ...play.tags]
      .join(" ")
      .toLowerCase();
    if (!haystack.includes(q)) return false;
  }
  return true;
}

/**
 * Client-side instant filter over the serialized play index: search input +
 * persona selector + category chip row, all URL-synced (?q=&category=&persona=)
 * so filtered views are shareable.
 */
export function PlaybookExplorer({
  plays,
}: {
  plays: PlayIndexEntry[];
}): JSX.Element {
  const router = useRouter();
  const params = useSearchParams();
  const filters = readFilters(new URLSearchParams(params));

  const setFilters = useCallback(
    (next: Filters) => {
      const sp = new URLSearchParams();
      if (next.q) sp.set("q", next.q);
      if (next.category) sp.set("category", next.category);
      if (next.persona) sp.set("persona", next.persona);
      const qs = sp.toString();
      router.replace(qs ? `/playbook?${qs}` : "/playbook", { scroll: false });
    },
    [router],
  );

  const visible = useMemo(
    () => plays.filter((p) => matches(p, filters)),
    [plays, filters],
  );

  const chip = (isActive: boolean) =>
    cn(
      "shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors duration-200",
      isActive
        ? "border-accent/60 bg-accent-tint text-white"
        : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
    );

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <input
            type="search"
            value={filters.q}
            onChange={(e) => setFilters({ ...filters, q: e.target.value })}
            placeholder="Search plays — symptom, channel, event…"
            aria-label="Search plays"
            className="w-full max-w-md rounded-md border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-white placeholder:text-white/35 focus:border-white/25 focus:outline-none"
          />
          <label className="flex items-center gap-2 text-sm text-white/50">
            For
            <select
              value={filters.persona ?? ""}
              onChange={(e) => {
                const v = e.target.value;
                setFilters({
                  ...filters,
                  persona: isPersonaSlug(v) ? v : undefined,
                });
              }}
              className="rounded-md border border-white/10 bg-white/[0.03] px-3 py-2.5 text-sm text-white focus:border-white/25 focus:outline-none"
            >
              <option value="">Everyone</option>
              {(Object.keys(PERSONAS) as PersonaSlug[]).map((p) => (
                <option key={p} value={p}>
                  {PERSONAS[p].label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <nav
          aria-label="Play categories"
          className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          <button
            type="button"
            onClick={() => setFilters({ ...filters, category: undefined })}
            className={chip(filters.category === undefined)}
          >
            All
          </button>
          {(Object.keys(CATEGORIES) as CategorySlug[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() =>
                setFilters({
                  ...filters,
                  category: filters.category === c ? undefined : c,
                })
              }
              className={chip(filters.category === c)}
            >
              {CATEGORIES[c].label}
            </button>
          ))}
        </nav>
      </div>

      {visible.length > 0 ? (
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {visible.map((play) => (
            <PlayCard key={play.url} play={play} />
          ))}
        </div>
      ) : (
        <div className="flex flex-col items-start gap-3 border-white/[0.08] border-t py-10">
          <p className="text-white/55">
            No plays match that filter yet — more are on the way.
          </p>
          <button
            type="button"
            onClick={() => setFilters({ q: "" })}
            className="text-sm text-white underline underline-offset-4 hover:text-white/80"
          >
            Reset filters
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Create `app/(home)/playbook/page.tsx`**

```tsx
import type { Metadata } from "next";
import { type JSX, Suspense } from "react";
import { PlaybookExplorer } from "@/components/playbook/playbook-explorer";
import { Eyebrow } from "@/components/ds/badge";
import { Section } from "@/components/ds/section";
import { getAllPlays, toPlayIndex } from "@/lib/playbook";

export const metadata: Metadata = {
  title: "The Growth Engineer's Playbook",
  description:
    "Short, concrete lifecycle plays that install — categorized by stage and role, each with the journey code that runs it.",
  alternates: { canonical: "/playbook" },
};

export default function PlaybookPage(): JSX.Element {
  const plays = toPlayIndex(getAllPlays());

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-12">
        <Eyebrow className="mb-4">The Playbook</Eyebrow>
        <h1 className="max-w-3xl font-display text-[40px] text-white leading-[1.1] tracking-[-0.02em] md:text-[56px]">
          Plays that install
        </h1>
        <p className="mt-5 max-w-2xl text-base text-white/60 leading-6">
          Lifecycle normally shows results in a month. If you're sending
          traffic without a robust lifecycle system, these plays show results
          within a day — each one ends with the journey code that runs it.
        </p>
      </Section>

      <Section containerClassName="py-12">
        <Suspense>
          <PlaybookExplorer plays={plays} />
        </Suspense>
      </Section>
    </main>
  );
}
```

- [ ] **Step 4: Verify types**

```bash
pnpm --filter @hogsend/docs check-types
```

Expected: PASS.

- [ ] **Step 5: Verify the registry validation fails the build end-to-end**

Temporarily set `category: bogus` in `content/playbook/proposal-opened-follow-up.mdx`, then:

```bash
pnpm --filter @hogsend/docs build
```

Expected: build FAILS with `Unknown playbook category "bogus" in /playbook/proposal-opened-follow-up`. Revert the edit, re-run the build, expected PASS.

- [ ] **Step 6: Visual smoke**

```bash
pnpm --filter @hogsend/docs dev
```

Open `http://localhost:3005/playbook`: hero renders, 2 cards in the grid, search for "dunning" narrows to 1, category chip + persona select filter and update the URL, empty state + reset works. (Full screenshot pass happens in Task 5.)

- [ ] **Step 7: Commit**

```bash
pnpm biome check --write apps/docs
git add apps/docs/components/playbook apps/docs/app/\(home\)/playbook
git commit -m "feat(docs): /playbook index — hero, instant filters, play card grid (#492)"
```

---

### Task 3: The remaining 10 skeleton plays

**Files:**
- Create: 10 files under `content/playbook/` (slugs below)

**Interfaces:**
- Consumes: the frontmatter schema from Task 1. Every file uses the same five-h2 skeleton body as Task 1 Step 5 (copy it; swap the snippet's journey id + trigger to match the slug), with the `{/* Draft skeleton — voice pass pending (#492 content phase). */}` marker.
- Produces: 12 total plays across 7 categories and all 5 personas — the browse UI is fully exercised.

- [ ] **Step 1: Create the 10 plays with this frontmatter matrix**

| slug | title | category | personas | blueprint | timeToResults |
|---|---|---|---|---|---|
| `day-one-activation-nudge` | Nudge signups to the aha moment on day one | `activation` | `[gtm]` | `day-one-activation-nudge` | same day |
| `aha-moment-shortcut` | Shortcut the setup that blocks activation | `activation` | `[]` | — | same day |
| `second-session-rescue` | Trial signups but no second session | `onboarding` | `[founders]` | — | 2–3 days |
| `pre-boarding-sequence` | Keep new hires warm between offer and day one | `onboarding` | `[recruiters, internal]` | — | one week |
| `usage-drop-early-warning` | Catch the usage drop before the churn email | `retention` | `[founders]` | — | same week |
| `weekly-usage-digest` | Send stakeholders a usage digest they'll actually read | `retention` | `[internal]` | — | one week |
| `silver-medalist-keep-warm` | Keep silver-medalist candidates warm for the next role | `winback` | `[recruiters]` | — | ongoing |
| `dormant-user-winback` | Re-open the conversation at 90 days dormant | `winback` | `[gtm]` | `dormant-user-winback` | one week |
| `sending-domain-warmup` | Warm up a new sending domain without burning it | `deliverability` | `[agencies]` | — | 2–4 weeks |
| `prove-the-journey-worked` | Prove the journey moved the metric | `measurement` | `[agencies, founders]` | — | one month |

Each file: `hook` = one honest symptom sentence (write a specific one per play, not lorem), `description` = one-line summary, `tags` = 2–3 relevant keywords, `date` = `2026-07-01` through `2026-07-14` (vary so sort order is deterministic and `dormant-user-winback` isn't newest). Body = the Task 1 skeleton with matching journey id/trigger.

- [ ] **Step 2: Verify**

```bash
pnpm --filter @hogsend/docs check-types && pnpm --filter @hogsend/docs build
```

Expected: both PASS (12 plays validate against the registries).

- [ ] **Step 3: Commit**

```bash
git add apps/docs/content/playbook
git commit -m "feat(docs): 12 skeleton plays across 7 categories and 5 personas (#492)"
```

---

### Task 4: Play detail page — five-part template, ladder CTA, related plays

**Files:**
- Create: `app/(home)/playbook/playbook.css`
- Create: `components/playbook/ladder-cta.tsx`
- Create: `app/(home)/playbook/[slug]/page.tsx`

**Interfaces:**
- Consumes: `playbookSource`, `getAllPlays`, `getRelatedPlays`, `toPlayIndex` from `@/lib/playbook`; `CATEGORIES`/`PERSONAS`; `PlayCard` from Task 2; `getMDXComponents` from `@/components/mdx`; `ShareButtons` from `@/components/articles/share-buttons`; `SITE_URL` from `@/lib/site`; `Section` + `ThermalLayer` ds primitives.
- Produces: `LadderCta` (self-serve / managed / DFY block, reused later phases).

- [ ] **Step 1: Create `app/(home)/playbook/playbook.css`**

```css
/* Play body typography — the five-part template as numbered sections. Scoped
   by class so it can't leak into docs/articles surfaces. */

.play-prose {
  color: rgba(255, 255, 255, 0.72);
  font-size: 1.0625rem;
  line-height: 1.75;
  counter-reset: play-step;
}

.play-prose > :first-child {
  margin-top: 0;
}

.play-prose p {
  margin-block: 1.25rem;
}

.play-prose h2 {
  counter-increment: play-step;
  display: flex;
  align-items: baseline;
  gap: 0.75rem;
  margin-block: 3rem 1rem;
  font-family: var(--font-display);
  font-size: 1.5rem;
  line-height: 1.25;
  letter-spacing: -0.02em;
  color: #fff;
}

.play-prose h2::before {
  content: counter(play-step, decimal-leading-zero);
  font-family: var(--font-mono, monospace);
  font-size: 0.8125rem;
  color: rgba(255, 255, 255, 0.35);
}

.play-prose ol,
.play-prose ul {
  margin-block: 1.25rem;
  padding-inline-start: 1.5rem;
}

.play-prose li {
  margin-block: 0.5rem;
}

.play-prose a {
  color: #fff;
  text-decoration: underline;
  text-underline-offset: 4px;
  text-decoration-color: rgba(255, 255, 255, 0.3);
}

.play-prose a:hover {
  text-decoration-color: rgba(255, 255, 255, 0.7);
}
```

(Code blocks inside the MDX body already render through `getMDXComponents()`'s
code styling — same as articles; do not restyle them here.)

- [ ] **Step 2: Create `components/playbook/ladder-cta.tsx`**

```tsx
import Link from "next/link";
import type { JSX } from "react";

const RUNGS = [
  {
    label: "Do it yourself",
    copy: "Self-host Hogsend and ship this play from your repo.",
    href: "/docs",
    cta: "Read the docs",
  },
  {
    label: "Managed",
    copy: "We run the infrastructure; you write the journeys.",
    href: "/pricing",
    cta: "See pricing",
  },
  {
    label: "Done for you",
    copy: "We design, build, and run your lifecycle system.",
    href: "/service",
    cta: "Talk to us",
  },
] as const;

/** The three-rung ladder block at the bottom of every play (no tracking yet). */
export function LadderCta(): JSX.Element {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {RUNGS.map((rung) => (
        <Link
          key={rung.href}
          href={rung.href}
          className="group flex flex-col gap-2 rounded-md border border-white/[0.08] bg-white/[0.015] p-5 transition-colors duration-200 hover:border-white/15"
        >
          <span className="font-mono text-[11px] text-white/45 uppercase tracking-[0.06em]">
            {rung.label}
          </span>
          <p className="text-[14px] text-white/60 leading-[1.55]">
            {rung.copy}
          </p>
          <span className="mt-auto pt-2 text-sm text-white underline underline-offset-4 decoration-white/30 transition-colors group-hover:decoration-white/70">
            {rung.cta}
          </span>
        </Link>
      ))}
    </div>
  );
}
```

- [ ] **Step 3: Create `app/(home)/playbook/[slug]/page.tsx`**

```tsx
import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { JSX } from "react";
import { ShareButtons } from "@/components/articles/share-buttons";
import { Section } from "@/components/ds/section";
import { ThermalLayer } from "@/components/ds/thermal";
import { getMDXComponents } from "@/components/mdx";
import { LadderCta } from "@/components/playbook/ladder-cta";
import { PlayCard } from "@/components/playbook/play-card";
import {
  getAllPlays,
  getRelatedPlays,
  playbookSource,
  toPlayIndex,
} from "@/lib/playbook";
import { CATEGORIES, type CategorySlug } from "@/lib/playbook/categories";
import { PERSONAS, type PersonaSlug } from "@/lib/playbook/personas";
import { SITE_URL } from "@/lib/site";
import "../playbook.css";

type Params = { slug: string };

export function generateStaticParams(): Params[] {
  return playbookSource.getPages().map((p) => ({ slug: p.slugs[0] ?? "" }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<Params>;
}): Promise<Metadata> {
  const { slug } = await params;
  const play = playbookSource.getPage([slug]);
  if (!play) return {};
  return {
    title: play.data.title,
    description: play.data.description,
    alternates: { canonical: play.url },
    openGraph: {
      type: "article",
      title: play.data.title,
      description: play.data.description,
      publishedTime: play.data.date,
    },
  };
}

export default async function PlayPage({
  params,
}: {
  params: Promise<Params>;
}): Promise<JSX.Element> {
  const { slug } = await params;
  const play = playbookSource.getPage([slug]);
  if (!play) notFound();

  const category = CATEGORIES[play.data.category as CategorySlug];
  const related = toPlayIndex(getRelatedPlays(getAllPlays(), play));
  const MDXBody = play.data.body;
  const canonicalUrl = `${SITE_URL}${play.url}`;

  return (
    <main className="flex flex-1 flex-col">
      <Section divider={false} containerClassName="pt-32 pb-12">
        <ThermalLayer strength={0.05} />
        <Link
          href="/playbook"
          className="mb-8 inline-flex items-center gap-1.5 text-sm text-white/50 transition-colors hover:text-white"
        >
          <ArrowLeft className="size-3.5" />
          Playbook
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/playbook?category=${play.data.category}`}
            className="rounded-full border px-2.5 py-0.5 font-mono text-[11px] uppercase tracking-[0.06em] transition-colors hover:text-white"
            style={{ borderColor: category.accent, color: category.accent }}
          >
            {category.label}
          </Link>
          {(play.data.personas as PersonaSlug[]).map((p) => (
            <Link
              key={p}
              href={`/playbook?persona=${p}`}
              className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-white/50 uppercase tracking-[0.06em] transition-colors hover:border-white/25 hover:text-white"
            >
              {PERSONAS[p].label}
            </Link>
          ))}
          {play.data.timeToResults ? (
            <span className="text-[12px] text-white/40">
              Results: {play.data.timeToResults}
            </span>
          ) : null}
        </div>
        <h1 className="mt-5 max-w-4xl font-display text-[34px] text-white leading-[1.12] tracking-[-0.02em] md:text-[48px]">
          {play.data.title}
        </h1>
        <p className="mt-5 max-w-2xl text-lg text-white/60 leading-7">
          {play.data.hook}
        </p>
      </Section>

      <section className="relative text-white">
        <div className="container-page py-8 md:py-12">
          <div className="grid gap-12 md:grid-cols-[220px_minmax(0,1fr)] md:gap-16">
            <aside className="hidden md:block">
              <div className="sticky top-32 flex flex-col gap-8">
                <ShareButtons
                  url={canonicalUrl}
                  slug={slug}
                  title={play.data.title}
                />
              </div>
            </aside>
            <div className="min-w-0">
              <article className="play-prose max-w-[42rem]">
                <MDXBody components={getMDXComponents()} />
              </article>
              <ShareButtons
                url={canonicalUrl}
                slug={slug}
                title={play.data.title}
                className="mt-12 md:hidden"
              />
            </div>
          </div>
        </div>
      </section>

      <Section containerClassName="py-16">
        <p className="eyebrow mb-6 text-white/50">Run it your way</p>
        <LadderCta />
      </Section>

      {related.length > 0 ? (
        <Section containerClassName="py-16">
          <p className="eyebrow mb-6 text-white/50">More plays</p>
          <div className="grid gap-5 md:grid-cols-3">
            {related.map((p) => (
              <PlayCard key={p.url} play={p} />
            ))}
          </div>
        </Section>
      ) : null}
    </main>
  );
}
```

Note: check `ShareButtons`' props in `components/articles/share-buttons.tsx` before wiring — if its share/UTM copy hardcodes "articles", pass-through as-is is still fine for this phase, but if it takes a `path`/`source` prop, set it to the play URL.

- [ ] **Step 4: Verify**

```bash
pnpm --filter @hogsend/docs check-types && pnpm --filter @hogsend/docs build
```

Expected: PASS; build statically generates 12 `/playbook/[slug]` pages.

- [ ] **Step 5: Visual smoke**

Dev server: open `/playbook/failed-payment-dunning` — numbered five-part sections (01–05), code block styled, category/persona chips link back to filtered index, ladder CTA + related plays render.

- [ ] **Step 6: Commit**

```bash
pnpm biome check --write apps/docs
git add apps/docs/app/\(home\)/playbook apps/docs/components/playbook
git commit -m "feat(docs): play detail page — five-part template, ladder CTA, related plays (#492)"
```

---

### Task 5: Nav + footer + sitemap, full verification pass

**Files:**
- Modify: `components/landing/site-nav.tsx:16-21` (NAV_LINKS)
- Modify: `components/landing/site-footer.tsx:39` (resources list)
- Modify: `app/sitemap.ts`

**Interfaces:**
- Consumes: `getAllPlays` from `@/lib/playbook` (sitemap).

- [ ] **Step 1: Add the nav link**

In `site-nav.tsx` NAV_LINKS, insert before Pricing:

```ts
const NAV_LINKS: Array<{ label: string; href: string }> = [
  { label: "Components", href: "/components" },
  { label: "Templates", href: "/emails" },
  { label: "Playbook", href: "/playbook" },
  { label: "Pricing", href: "/pricing" },
  { label: "Docs", href: "/docs" },
];
```

- [ ] **Step 2: Add the footer link**

In `site-footer.tsx`, next to the Articles entry:

```ts
{ label: "Playbook", href: "/playbook" },
```

- [ ] **Step 3: Add playbook to `app/sitemap.ts`**

Import and append after `docsPages`:

```ts
import { getAllPlays } from "@/lib/playbook";
```

```ts
const playbookPages = [
  {
    url: `${SITE_URL}/playbook`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.8,
  },
  ...getAllPlays().map((play) => ({
    url: `${SITE_URL}${play.url}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  })),
];
```

and spread `...playbookPages` into the returned array after `...marketingPages`.

- [ ] **Step 4: Full gate**

```bash
pnpm biome check --write apps/docs
pnpm --filter @hogsend/docs check-types
pnpm --filter @hogsend/docs build
```

Expected: all PASS.

- [ ] **Step 5: Real-UI screenshot pass (standing rule — no mockups)**

Run `pnpm --filter @hogsend/docs dev`, then screenshot with the browser tools:
1. `/playbook` — full index, all 12 cards
2. `/playbook?category=winback` — chip active, 2 cards
3. `/playbook?persona=recruiters` — persona filtered
4. `/playbook?q=dunning` — search narrowed
5. `/playbook/failed-payment-dunning` — detail, template sections + ladder
6. Mobile viewport (390px) of index + detail

Present screenshots to Doug in chat before any merge.

- [ ] **Step 6: Commit**

```bash
git add apps/docs/components/landing/site-nav.tsx apps/docs/components/landing/site-footer.tsx apps/docs/app/sitemap.ts
git commit -m "feat(docs): playbook nav, footer, and sitemap entries (#492)"
```

---

## Self-review notes

- Spec coverage: route+IA (T2/T4/T5), pipeline+registries (T1), 12 skeletons ≥4 categories ≥3 personas (T1+T3 = 7 categories, 5 personas), index UI (T2), detail+ladder+related+share (T4), nav (T5), verification incl. real-UI screenshots (T5). Deferred items match the spec's out-of-scope list.
- `referral` category ships with zero plays in phase 1 — the chip still renders (registry-driven); acceptable since content phase fills it, and the empty state handles the click gracefully.
- `PlayIndexEntry` is the single cross-task card contract; detail page reuses it via `toPlayIndex(getRelatedPlays(...))`.
