# Plan: Feature-Flags Phase 2 — full-page authoring + condition sets + richer targeting

## Context

Native feature flags shipped (backend + SDK + Studio + Phase-1 visual `<ConditionBuilder>`,
committed on `feat/native-flags`). Two gaps remain, both raised by Doug:

1. **Authoring UX**: create/edit lives in a **modal** that hides the flags list — a
   "disconnect". It should be a spacious **full-page** experience (like PostHog's
   `/feature_flags/new`), smooth, in the dark Studio system.
2. **Targeting power**: today a flag targets **contact properties only**, as a single
   tree with one rollout. Hogsend already holds buckets, journeys, deals, campaigns and
   event history — targeting should reach all of them, and support **PostHog-style
   condition sets** (multiple sets, each with its own rollout %; first match wins).

Decisions (locked): **full-page route** authoring surface; **multiple condition sets**.

Execution: **ultracode workflow** after this plan is approved. Copy this file to
`docs/superpowers/plans/2026-07-18-flags-phase2.md` at execution start (durable home).

---

## Strand A — Backend: condition sets, richer sources, snapshot eval, match count

### A1. Condition-sets data model (`packages/core/src/flags/`, `packages/db`, engine)
- A flag's targeting becomes an **ordered array of condition sets**:
  `conditionSets: Array<{ description?: string; targeting: FlagTargeting; rollout: number }>`.
  Reuse the existing `FlagTargeting` tree per set (`core/src/flags/types.ts`).
- **DB**: add `flags.condition_sets` jsonb (migration via `packages/db` `db:generate`).
  Keep legacy `targeting`/`rollout` columns; on read, when `condition_sets` is null,
  synthesize `[{ targeting, rollout }]` (back-compat, no data loss). New writes populate
  `condition_sets`.
- **Zod** (`core/src/flags/schema.ts`): `flagConditionSetSchema` + accept `conditionSets`
  on create/update; keep accepting legacy `targeting`+`rollout` (normalized server-side).
- **Evaluator** (`packages/engine/src/lib/flags.ts` `evaluateFlag`): iterate sets in order;
  a set matches when its `targeting` evaluates true AND the contact is in its rollout
  (`flagBucket(contactKey + ':' + flag.key + ':' + setIndex) < set.rollout`). First
  matching set → flag ON (boolean `true` / multivariate arm picked as today). No set
  matches → `defaultValue`. Empty `conditionSets` or a set with empty targeting = everyone
  (subject to that set's rollout). Keep the existing empty-composite = everyone fix.

### A2. Richer targeting leaves + the per-request snapshot (the perf boundary)
The browser `GET /v1/flags` evaluates **every flag per request**, so eval must stay
**O(1) queries** (see `evaluateFlagsForContact`, `lib/flags.ts:151`). Design:
- **Targeting snapshot** — new `loadTargetingSnapshot({ db, contactKey, contactId })` loads,
  in a **fixed ~4 indexed queries** (keyed on the `contactKey` + `contactId` that
  `resolveFeedRecipient` already returns): `properties` (existing), `buckets: Set<bucketId>`
  (`bucket_memberships` where `userId=contactKey` + active — pattern at
  `buckets/check-membership.ts:184`), `journeys: Map<journeyId,status>` (`journey_states`
  where `userId=contactKey`), `deals` state (`deals` where `contactId=<uuid>` — `soldAt`,
  `canonicalStage`). Evaluate ALL flags against this in-memory snapshot with **pure,
  DB-free** leaf kinds.
- **New leaf condition kinds** (extend `FlagTargeting` union + `evaluateTargeting`):
  `property` (existing), **`bucket`** (in bucket X → snapshot Set), **`journey`**
  (in / completed journey X → snapshot Map), **`deal`** (won / open / stage=X → snapshot).
  These are **cheap on both reads**.
- **Server-only leaves** — **`event`** (did event X within N) and **`email_engagement`**
  can't be snapshot-bounded (per-condition scans). They evaluate via core's async
  `evaluateCondition` (`packages/core/src/conditions/evaluate.ts`) **only on the secret
  `POST /v1/flags/evaluate`** path. On the publishable `GET /v1/flags`, a leaf of these
  kinds evaluates to **false** (and the editor warns "server-side only"). Branch on
  `c.get("publishable")` (already available). Campaigns: **server-only for v1** (no
  by-contact index on `campaign_recipients`); revisit with an index later.

### A3. Catalog + match-count endpoints (`packages/engine/src/routes/admin/targeting.ts`)
- **Extend** `GET /v1/admin/targeting/catalog` → add sources for the builder's typed
  pickers: `buckets` (`bucketRegistry.getAll()`), `journeys` (`registry.getAll()`),
  `dealStages` (the `deals` canonical-stage enum), `events` (`listEventNameVocabulary`,
  `lib/event-names.ts`), `campaigns` (db `campaigns` list). Keep `properties`/`operators`.
- **Net-new** `POST /v1/admin/targeting/count` → takes a `FlagTargeting` tree (one set),
  returns an **estimated** matching-contact count for the editor's "Filters match ~N
  contacts". v1: **sampled in-memory** estimate — load a bounded sample of live contacts
  (mirror the catalog's ~2000-most-recent sampling) + their snapshot state, evaluate the
  tree, return `{ matched, sampled, estimatedTotal }`. Honest estimate, bounded cost;
  admin-guarded.

### A4. Tests (`apps/api/src/__tests__/`)
- Evaluator: first-matching-set wins; per-set rollout; back-compat legacy `targeting`;
  bucket/journey/deal snapshot leaves; event/engagement server-only (false on browser,
  resolved on server); empty set = everyone.
- Snapshot loader query count is fixed (not per-flag). Catalog returns all sources.
  Count endpoint returns a sane estimate.

---

## Strand B — Frontend: full-page flag editor (front-end-design overhaul)

### B1. Routes + list nav (`packages/studio/src/routes/index.tsx`, `views/flags-view.tsx`)
- Add `/flags/new` (`<FlagEditorView mode="create"/>`) and `/flags/$flagId`
  (`<FlagEditorView mode="edit" flagId=.../>`) using the house recipe (read `$param` in the
  route wrapper, pass as prop; register `/flags/new` **before** `/flags/$flagId`). Sidebar
  auto-highlights via `startsWith("/flags")` — no nav change.
- List: "New flag" → `useNavigate({ to: "/flags/new" })`; row click → `/flags/$flagId`
  (cursor-pointer `TableRow`, per `campaigns-view.tsx:187`). **Keep** the inline enabled
  `Switch` + archive on the list. **Delete** `FlagFormDialog`; extract `FormState`,
  `initialForm`, `buildBody`, `slugify`, `JsonField` into a shared `views/flags/flag-form.ts`
  the editor consumes.

### B2. `FlagEditorView` — the full page (mirror `campaign-detail-view.tsx` layout)
- Header: back-`Link` to `/flags` + title + a **sticky Cancel / Save** action (PostHog-style
  top-right). Two-column `grid gap-4 lg:grid-cols-2` of `Card` sections:
  - **General**: Name → auto-derived editable Key (reuse slugify), Description, Enabled `Switch`.
  - **Flag type**: net-new **radio cards** (Boolean / Multivariate) from `Card` + accent
    ring/check (`border-accent`); multivariate reveals the variants editor.
  - **Release conditions**: the **condition-set repeater** — an array of cards, each =
    a `<ConditionBuilder>` (reused; field picker extended to typed sources from the
    catalog) + a **rollout slider** (net-new, native range styled to tokens) + the live
    **"Filters match ~N contacts"** estimate (debounced `POST /targeting/count`) +
    remove. "Add condition set" appends. Server-only leaves show a subtle "server-side
    only" note.
  - **Advanced** (collapsible `useState`): default value, (later: payload/tags).
- Save → `createFlag`/`updateFlag` with `conditionSets`; house `useMutation` +
  `invalidateQueries(["flags"])` + `toast`; navigate back to `/flags`. Optional
  unsaved-changes guard via TanStack `useBlocker` (net-new; nice-to-have).

### B3. Design direction (frontend-design skill; dark "crimzon", NOT PostHog's light look)
- Reuse tokens: `--color-accent #f64838`, `--color-ink` page bg, `--color-raised` cards,
  `border-hairline-faint` default border, `font-display` headings, Geist Mono for keys.
- **Signature element**: the condition-set cards with the AND/OR builder + rollout slider +
  live match count — the one powerful, memorable thing. Keep everything else quiet and
  consistent with existing detail views. Motion stays Tailwind `transition-* duration-200`
  (no new animation lib). Responsive down to one column; visible focus; reduced-motion ok.

### B4. Builder typed-source extension (`components/condition-builder/`)
- Add a **source picker** to `ConditionRow`: Property | Bucket | Journey | Deal | Event.
  Each source drives its own operator/target inputs (bucket → bucket dropdown; journey →
  journey dropdown + in/completed; deal → won/open/stage; event → event dropdown +
  count/within; property → today's property+operator+value). Emits the typed leaf.
  Component stays controlled/reusable (so buckets + journeys can adopt it later).

---

## Phasing (ultracode workflow, executable increments)
1. **A1–A2 backend**: condition-sets model + migration + evaluator + snapshot loader +
   bucket/journey/deal leaves + server-only event/engagement + tests. (Review-gated;
   the browser-read-must-stay-O(1)-queries invariant is the top verify gate.)
2. **A3 backend**: catalog extension + match-count endpoint + tests.
3. **B1–B2 frontend**: full-page editor + routes + delete modal + condition-set repeater +
   flag-type cards + rollout slider + advanced.
4. **B4 + B3 polish**: typed-source builder + live match estimate wiring + design pass.
5. **Review + live screenshot** on localhost.

Each phase: adversarial review (Opus fallback while Fable credits are out) → real vitest
against Postgres 5434 → Studio build → commit on `feat/native-flags`. Not pushed.

## Verification
- **Backend**: vitest for the evaluator (set precedence, per-set rollout, back-compat,
  each new leaf, server-only behavior), snapshot query-count, catalog, count endpoint;
  run the real API (demo worktree on :3012) and hit `GET /v1/flags` + `POST
  /v1/flags/evaluate` for a seeded contact across sources.
- **Frontend**: build Studio, run on :3012, create a flag with 2 condition sets + a
  bucket/journey/deal condition through the full-page editor, confirm the list row + the
  live match estimate, screenshot. Type-check all touched packages; Biome clean.
