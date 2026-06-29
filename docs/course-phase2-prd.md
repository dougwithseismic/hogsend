# Phase 2 PRD — Free reader sign-up + lesson gating for `apps/course`

*Generated from the `course-phase2-design` workflow (research + architect synthesis).
Companion: [`course-phase2-plan.md`](./course-phase2-plan.md).*

## Goal
Add a free account layer to the course site (`apps/course`, `course.hogsend.com`) that
gates most lesson content behind a sign-up, while keeping the catalog, course
overviews, and each course's first lesson fully public and SEO-indexable. Sign-up uses
Better Auth with two passwordless methods: email magic-link and GitHub OAuth. Account
creation, enrollment, and lesson progress emit `course.*` events to the dogfood engine
via the existing `lib/ingest.ts`. Phase 4 (separate) consumes those events with
journeys; Phase 2 only fires them.

## Who it's for
- Readers of the "Measure, Keep, and Grow" course (technical founders + consultants).
  They get free, frictionless sign-up to unlock the full course.
- The growth team: gating converts anonymous readers into identified contacts in the
  Hogsend graph, keyed by email, feeding lifecycle journeys later.

## In scope
- A new, fully isolated Better Auth instance in `apps/course` with its OWN Postgres +
  Drizzle (no reuse of the engine/dogfood admin auth or DB).
- Auth methods: magic-link (Resend-delivered, direct) + GitHub OAuth. Open sign-up
  (`disableSignUp: false`).
- 6 DB tables: Better Auth core 4 (`user`, `session`, `account`, `verification`) + 2
  app tables (`enrollment`, `lesson_progress`).
- Server-side (RSC) gate on the lesson route; DS-styled sign-in page + lesson wall, all
  dark crimzon.
- `course.*` event emission: `course.signed_up`, `course.enrolled`,
  `course.lesson_completed`, `course.completed` (best-effort, email-identified).
- Deploy: new Railway service + dedicated Railway Postgres + pre-deploy migration;
  Cloudflare DNS for `course.hogsend.com`.

## Out of scope / non-goals
- No password (email+password) auth. Passwordless + OAuth only.
- No Phase-4 journeys — events are fired, not consumed here.
- No changes to `apps/docs`, the dogfood repo, the dogfood admin Better Auth instance,
  or the engine DB.
- No new DS color tokens, no theme toggle, no light mode.
- No search route in this phase (when added later it MUST be filtered to public pages —
  see plan security checklist).
- No middleware-as-security-boundary. An optional `proxy.ts` optimistic redirect is
  allowed but is not the lock.
- No paid tiers, no multi-tenant, no certificates.

## Exact gating policy
Route shape: lessons live at `/learn/[[...slug]]` where `slug = [courseSlug, lessonFile]`
(e.g. `["growth-with-posthog","01-what-is-posthog"]`).

PUBLIC (static SSG, indexable, no session read):
- Catalog `/` (already static).
- Each course overview `/[course]` (already static).
- The FIRST lesson of each course = `lessons[0]` for that course, sorted by
  `slugs.join("/")` lexically (the `01-`/`02-` numeric prefixes make lexical sort ==
  `meta.json` `pages` order). For `growth-with-posthog` that is `01-what-is-posthog`.

GATED (dynamic, session required, never prerendered, `robots: { index:false }`):
- Every other lesson under `/learn/[[...slug]]`.

Mechanism: `generateStaticParams()` returns ONLY public (first-lesson) params;
`dynamicParams = true` lets gated lessons render on demand. The gated branch is the only
code path that calls `headers()`/`getSession()`, so public pages stay statically
materialized and indexable, and gated bodies are never baked into static `.html`/`.rsc`
files.

Authoritative check: the lesson Server Component calls
`auth.api.getSession({ headers: await headers() })`. No session → render a DS lesson
wall (teaser title/description + "Create a free account" CTA → `/sign-in?next=<lessonUrl>`);
it does NOT hard-redirect, so the URL survives for post-auth return. Session present →
ensure enrollment + record progress → render the MDX.

## Auth UX
- Sign-in page `/(auth)/sign-in` (dark crimzon, built only from `components/ds`): one
  email field → magic-link; one "Continue with GitHub" button → GitHub OAuth. Reads
  `?next=` (validated relative path only) and passes it as `callbackURL`.
- Magic-link: enter email → "check your inbox" state. Email is sent directly by the
  course app via Resend (carries a single-use, 15-min token; cannot be deferred to a
  journey). Clicking the link verifies and returns to `next` (or `/`).
- GitHub: redirects to GitHub, returns to `/api/auth/callback/github`, then to `next`.
  Account auto-links to an existing same-(verified)-email user (safe convergence of
  magic-link + GitHub on one user).
- Redirect-back: after a wall CTA → sign-in → auth, the user lands on the originally
  requested lesson via `callbackURL`/`next`.
- Sign-out: a small session-aware user menu in the learn nav (`signOut()`).
- New-user creation is implicit (magic-link/GitHub auto-create on first sign-in).

## Success criteria
- Catalog `/`, every `/[course]`, and each course's first lesson render WITHOUT a
  session, are statically generated, and carry indexable SEO metadata (verified: no auth
  redirect, no `noindex`).
- Any non-first lesson with no session shows the DS wall (not the body) and is
  `noindex`; the RSC stream / `_next/data` payload for that lesson never returns the
  gated body to an anonymous client.
- Magic-link sign-in and GitHub sign-in both succeed and return the user to the
  originally requested lesson.
- A new account fires exactly one `course.signed_up`; first gated access fires one
  `course.enrolled`; these reach the dogfood engine (idempotent at the engine via
  Idempotency-Key, identified by email).
- `pnpm --filter @hogsend/course build` stays green; `apps/docs` and dogfood untouched.
- `course.hogsend.com` serves over TLS via Railway behind Cloudflare; pre-deploy
  migration creates all 6 tables.

## Non-goals (restated for clarity)
Passwords, Phase-4 journeys, search, light theme, multi-tenant, certificates, and any
modification to `apps/docs` / dogfood admin auth / engine DB.
