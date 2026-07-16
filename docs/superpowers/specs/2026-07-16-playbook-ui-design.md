# Playbook UI — phase 1 design (stubbed content)

Ticket: #492 — The Growth Engineer's Playbook. This phase builds the UI surface
with skeleton content; tracking, journeys, blueprints, and real copy come in
later phases.

## Goal

A hero `/playbook` surface in `apps/docs` — a searchable, browsable library of
micro-plays. Card grid + instant filters, visually distinct from `/articles`
(library, not blog). Individual play pages render the five-part play template.

## Scope

In: index page, play detail page, MDX content pipeline, 12 skeleton plays,
ladder CTA block (static links), nav link.

Out (later phases): reading-event tracking into dogfood, "one play a week"
capture journey, blueprint install verification, real play copy (voice pass),
category hub pages (`/playbook/category/[x]`), playbook-specific OG images.

## Route & IA

- `apps/docs/app/(home)/playbook/page.tsx` — index.
- `apps/docs/app/(home)/playbook/[slug]/page.tsx` — play detail,
  `generateStaticParams` + per-play metadata.
- Filter state (category, persona, `q`) in URL search params — shareable.
- `/playbook` added to the site header nav.

## Content pipeline

- New `playbook` collection in `source.config.ts`, dir `content/playbook`,
  mirroring the `articles` collection pattern.
- Frontmatter schema (Zod): `title`, `hook` (one-line "when to run it"
  symptom), `category` (enum of 8: activation, onboarding, retention, revenue,
  winback, referral, deliverability, measurement), `personas` (array of gtm /
  founders / recruiters / internal / agencies; empty = everyone), `tags`,
  `date`, optional `blueprint` (slug → "Installs" badge), optional
  `timeToResults` (e.g. "same day").
- `lib/playbook/`: `index.ts` (loader + validated getters), `categories.ts`
  and `personas.ts` registries (label, accent color token, blurb). Unknown
  slugs fail the build, same as article tags/authors.
- 12 skeleton `.mdx` plays across ≥4 categories and ≥3 personas. Bodies use
  the five-part template as h2 sections: When to run it / Why it works /
  The play / Ship it with Hogsend / How you'll know. Placeholder voice —
  clearly marked as drafts in content, honest structure.

## Index UI

- Hero: eyebrow, display title, the promise line ("lifecycle normally shows
  results in a month; with traffic and a robust lifecycle system, within a
  day").
- Filter bar: search input + compact persona selector on one line; category
  chip row beneath. All combine.
- `PlaybookExplorer` client component receives the serialized play index
  (title, hook, slug, category, personas, tags, blueprint flag) and does
  instant substring filtering; URL-synced.
- Responsive grid (3-col desktop, 1-col mobile) of typographic `PlayCard`s:
  category color accent, title, hook line, persona chips, "Installs" badge
  when `blueprint` set. No cover images — deliberately different from
  articles.
- Empty-filter state with a reset action.
- Built on existing ds primitives (`Section`, `Eyebrow`, `Badge`, `Card`) and
  the dark crimzon system.

## Detail page

- Header: category badge, persona chips, title, hook, time-to-results.
- MDX body with the five template h2s styled as distinct numbered sections.
- "Ship it with Hogsend" code renders via existing `code-window` /
  `code-highlight` ds primitives through the MDX component map.
- Bottom: ladder CTA block (self-serve / managed / DFY — real links, no
  tracking), 3 related plays (same category), share buttons reused from
  articles.

## Verification

Biome, `check-types`, docs build; then run the real app and screenshot index,
detail, and filtered states before commit — no HTML mockups.
