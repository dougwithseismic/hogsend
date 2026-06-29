# Course Platform Plan — `course.hogsend.com`

**Status:** proposal, awaiting greenlight on the flagged decisions (§8).
**Goal:** a standalone, fully-fledged course site (multiple courses, many lessons),
free but requiring sign-up, sharing the crimzon design system with `apps/docs`, with
the **hogsend-dogfood** engine as its identity + lifecycle backend.

The first course is the one already drafted in [`docs/course/`](./course/) ("Measure,
Keep, Grow" — PostHog + Hogsend). This plan is how it (and future courses) ship to
users.

---

## 1. The shape, in one line

A new Next.js app (`course.hogsend.com`) that **owns the reading experience + reader
auth + lesson progress**, and **pipes `course.*` events to the dogfood engine** so
every sign-up becomes a contact running through real lifecycle journeys.

```
                course.hogsend.com  (NEW frontend app)
        ┌───────────────────────────────────────────────┐
        │  crimzon design system (shared from apps/docs) │
        │  fumadocs MDX  ·  course catalog · lesson reader│
        │  Better Auth (magic-link + GitHub) · progress  │
        └───────────────┬───────────────────────────────┘
       reader auth + progress │           │ server-side ingest
       (own Postgres)         │           │ (course.* events)
                              ▼           ▼
                      ┌─────────────────────────────────┐
                      │  hogsend-dogfood  (EXISTING)      │
                      │  contacts · journeys · emails ·   │
                      │  Discord/Telegram · identity graph│
                      └─────────────────────────────────┘
                                    │
                                    ▼
                         PostHog  (analytics, already wired)
```

**Division of labour** (the same split the course itself teaches):

- **Course app owns:** the reader experience, reader accounts/sessions, and
  course-specific app-state (enrollment, lesson progress, completion). This is *app
  state*, and it belongs in the app — not in the analytics/messaging engine.
- **Dogfood owns:** identity-as-contacts, lifecycle journeys, transactional + marketing
  email, the Discord/Telegram identity graph, and the PostHog fan-out. All of this
  already exists.

> **Why reader auth lives in the course app, not the dogfood's Better Auth:** the
> engine's Better Auth is deliberately *admin-only* (Studio hardening — web sign-up
> disabled, CLI-bootstrapped first admin). Course readers are a different, public
> population, and their app-state (progress/enrollment) is course-specific. Standing up
> a second, reader-scoped Better Auth in the course app keeps the admin surface
> hardened and mirrors exactly how a real customer would build on Hogsend — *their app
> has its own auth and emits events to Hogsend for the lifecycle.* The course platform
> becomes a live reference implementation.

---

## 2. Why this is lean (reuse, not rebuild)

Almost everything except the reading UI and the gate already exists somewhere:

| Need | Source | New work |
|---|---|---|
| Design system (crimzon, dark) | `apps/docs/components/ds/*` + `@theme` | Extract to a shared package (§3) |
| MDX content pipeline | fumadocs (already in `apps/docs`) | Add a `courses` collection |
| Server→engine event ingest | `apps/docs/lib/ingest.ts` (`POST /v1/events`) | Copy the helper, add `course.*` events |
| Contacts + identity graph | dogfood engine | None |
| Lifecycle journeys + emails | dogfood `docs-*` journeys | Adapt for `course.*` triggers |
| In-app feed/bell (optional) | `@hogsend/react` (used by docs bell) | Mount in the course shell |
| Railway deploy pattern | `Dockerfile.docs` + `railway.docs.toml` | Clone as `Dockerfile.course` |

The genuinely **new** pieces are: (a) Better Auth + a small Postgres for readers, (b)
the catalog/lesson-reader UI, and (c) progress tracking. That's the whole delta.

---

## 3. The frontend app (`apps/course`)

Lives in **this monorepo** as a sibling to `apps/docs` (recommended — see §8 decision
A), so it shares the design system and the Next/Tailwind/fumadocs stack already proven
there.

- **Stack:** Next.js 16 (App Router, `output: "standalone"`), React 19, Tailwind v4 —
  mirror `apps/docs` exactly. Dark-only crimzon.
- **Design system:** extract `apps/docs/components/ds/*`, the crimzon `@theme` tokens
  from `app/global.css`, `lib/cn.ts`, and `lib/fonts.ts` into a shared workspace package
  **`packages/ds` (`@hogsend/ds`)**, consumed by both `apps/docs` and `apps/course`.
  (v0 shortcut: copy the files. Recommended: extract, so the two sites can't drift.)
- **Content:** a second fumadocs collection in `source.config.ts`:
  `content/courses/<course-slug>/<NN-lesson>.mdx`, with a `meta.json` per course for
  lesson order/title, and frontmatter per lesson (`title`, `summary`, `minutes`,
  `access: "free" | "preview"`). fumadocs gives sidebar nav + search for free.
- **Route groups under `app/`:**
  - `app/(catalog)/` — **public**: the course catalog (all courses), each course's
    overview (lesson list, preview, "enroll"). Indexable for SEO/traffic.
  - `app/(learn)/learn/[course]/[lesson]/` — **gated**: the lesson reader. Protected by
    middleware; redirects to sign-in.
  - `app/api/auth/[...all]/` — Better Auth handler.
  - `app/api/progress/` — mark lesson complete, read progress.
  - `lib/ingest.ts` — the ported server→dogfood event emitter.
- **Gating policy (recommended):** catalog + course overview + **lesson 1 of each
  course** are public (SEO + taste); the rest requires a free account. The course is a
  traffic asset, so some content must be indexable.

---

## 4. Auth + app-state (Better Auth + Postgres in the course app)

- **Better Auth (Next.js)** with **magic-link** (passwordless = built-in email
  verification, and on-brand: it *is* the verified-email identity the course teaches)
  plus **GitHub OAuth** (the audience is developers) and optionally Google.
- **Its own Postgres** (a new DB for the course service — Railway Postgres or Neon;
  §8 decision C). Drizzle ORM, to match the rest of the stack.
- **Tables:** Better Auth's `user` / `session` / `account` / `verification`, plus:
  - `enrollment(user_id, course_slug, enrolled_at)`
  - `lesson_progress(user_id, course_slug, lesson_slug, completed_at)`
- **Auth transactional email** (the magic-link itself): send via **Resend directly**
  from the course app (recommended — keeps auth self-contained), while *lifecycle*
  email goes through the dogfood. (Alternative: route auth email through the dogfood's
  transactional send; more coupling for little gain.)

---

## 5. Lifecycle: the dogfood does what it already does

On the key reader actions, the course app emits **server-side events** to the dogfood
via the proven ingest channel (`lib/ingest.ts` → `POST /v1/events`, Bearer key,
idempotency key — identical to how `apps/docs` already forwards `subscribe`/`sample`):

| Course event | Dogfood journey (new or adapted from existing `docs-*`) |
|---|---|
| `course.signed_up` | Welcome (adapt `docs-welcome`) |
| `course.enrolled {course}` | Per-course onboarding nurture (adapt `docs-nudge`/`docs-build`) |
| `course.lesson_completed {course, lesson}` | Progress reinforcement; "next lesson" nudge |
| **stalled** (no `lesson_completed` in N days) | Behavioural re-engagement — the `activation-nudge-series` pattern from the course itself |
| `course.completed {course}` | Completion → referral ask (`docs-referral-ask`) + setup-week upsell (`docs-setup-offer`/`docs-setup-lastcall`) |

Identity: the contact is keyed by **verified email**; the course's Better Auth user ↔
the dogfood contact link by that email, joining the existing identity graph (Discord/
Telegram/anon). Optionally mount the **`@hogsend/react` feed/bell** inside the course
shell for "badge earned / next lesson" notifications — dogfooding the in-app product
inside the course *about* the product.

This is the course's own Chapter 8 flywheel, pointed at the course platform: free
sign-up → owned contact → lifecycle journeys → referral + upsell, all measurable in
PostHog.

---

## 6. Content model & seeding

- A **course** = a folder of MDX lessons + `meta.json` + per-lesson frontmatter.
- **Seed with one course:** port `docs/course/*.md` (the 9 "Measure, Keep, Grow"
  chapters) → `content/courses/growth-with-posthog/*.mdx`, swapping plain code fences
  for the crimzon `CodeWindow`/`Callout` DS components. (This is the Phase-2 "port to
  MDX" from the course draft — now landing in the course app instead of `apps/docs`.)
- **Structure supports "loads of courses"** from day one; candidate future courses to
  outline (not build yet): *Code-first journeys with Hogsend*, *Email deliverability &
  identity*, *Community-led growth with Discord/Telegram*.

---

## 7. Deployment

- New Railway service for `apps/course` → **`course.hogsend.com`** (Cloudflare CNAME →
  Railway). Clone the docs deploy: **`Dockerfile.course`** (turbo
  `build --filter=@hogsend/course`, Next standalone, `assemble-standalone`) +
  **`railway.course.toml`** (`dockerfilePath`, `watchPatterns: apps/course/**`,
  healthcheck `/`).
- **New Postgres** for the course service (§8 decision C).
- **Env:**
  - Build-time `NEXT_PUBLIC_*`: `NEXT_PUBLIC_HOGSEND_API_URL` (= `t.hogsend.com`),
    `NEXT_PUBLIC_HOGSEND_PUBLISHABLE_KEY` (`pk_…`, for the feed/bell),
    `NEXT_PUBLIC_POSTHOG_KEY`.
  - Server-only: `DATABASE_URL` (course DB), `BETTER_AUTH_SECRET`, GitHub OAuth
    client id/secret, `RESEND_API_KEY` (auth email), `HOGSEND_INGEST_URL` +
    `HOGSEND_INGEST_KEY` (server→dogfood lifecycle events).

---

## 8. Decisions to confirm (I have a recommendation for each)

- **A. Where the app lives** → **`apps/course` in this (growthhog) monorepo.** Shares
  the crimzon DS and the Next/fumadocs stack with `apps/docs`; the dogfood stays the
  backend. (Alternative: put it in the dogfood repo — but that repo is backend-only with
  no frontend or DS, so the DS would have to be published/duplicated. Not recommended.)
- **B. Design system** → **extract `components/ds` to `packages/ds` (`@hogsend/ds`)**
  shared by both sites. (Alternative: copy for v0, extract later.)
- **C. Course database** → **Railway Postgres** alongside the service (consistent with
  the rest of the infra) *or* **Neon** if you'd rather a serverless DB. Mild preference
  for Neon for a small, separate app's auth DB; either is fine.
- **D. Auth methods** → **Better Auth magic-link + GitHub OAuth** (dev audience).
- **E. Gating** → **catalog + overview + lesson 1 public; rest behind free sign-up.**

---

## 9. Phasing (each phase ships something real)

| Phase | Deliverable | Rough effort |
|---|---|---|
| **0** | Extract crimzon DS → `packages/ds`; both `apps/docs` and new `apps/course` consume it | 0.5–1 day |
| **1** | Scaffold `apps/course` (Next + fumadocs + DS, dark crimzon). Public catalog + course overview + **ungated** lesson reader. Port the growth course to MDX. Deploy to `course.hogsend.com` | 2–3 days |
| **2** | Better Auth (magic-link + GitHub) + Postgres + middleware gating. Sign-up required for lessons beyond the public preview | 1.5–2 days |
| **3** | Progress tracking (enrollment + lesson_progress), "continue where you left off," course-complete state | 1–1.5 days |
| **4** | Wire `course.*` events → dogfood; adapt `docs-*` journeys (welcome, stalled-nudge, completion → referral + upsell) | 1–1.5 days |
| **5** | Polish: gamification/badges, in-app feed/bell via `@hogsend/react`, multi-course catalog, seed a 2nd course | 2–3 days |

Phase 1 alone is a real, public, branded course site. Auth, progress, and lifecycle
layer on without rework.

---

## 10. Risks / notes

- **DS extraction churn** — moving `components/ds` to a package touches `apps/docs`
  imports. Do it as Phase 0 in its own PR, verify the docs site renders unchanged
  before building on it.
- **fumadocs multi-collection** — confirm a second `defineDocs` collection (`courses`)
  coexists with the existing `docs` collection cleanly.
- **Magic-link deliverability** — auth email must be reliable (it's the gate). Use Resend
  with a verified sending domain; monitor.
- **SEO vs gating** — keep enough public (catalog, overviews, lesson 1) that the course
  earns the search traffic it's meant to drive; gate the depth, not the front door.
- **Don't regress Studio auth** — the course app's Better Auth is entirely separate from
  the engine's admin auth. No changes to the dogfood's auth.

---

*References: course draft [`docs/course/`](./course/); design system + ingest pattern in
`apps/docs` (`components/ds`, `lib/ingest.ts`, `Dockerfile.docs`, `railway.docs.toml`);
dogfood engine (sibling `hogsend-dogfood` repo — contacts, journeys, `better-auth`,
magic-link/web-link); [`docs/competitive-positioning.md`](./competitive-positioning.md).*
