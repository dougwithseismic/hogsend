# PRD 01 — Anonymous-only contacts are a display concern

## Goal

Studio's contacts list currently shows every live `contacts` row, so a deployment that has been
running a browser SDK for a month opens on a wall of anonymous visitors and the operator concludes
the CRM is full of ghosts. Add one server-side predicate — "has this person ever identified?" — to
`GET /v1/admin/contacts`, default the **Studio** list to identified-only, and give the operator a
toggle to see the anonymous tail on purpose. This is the cheap answer to the complaint that #621
answered structurally (DECISIONS §4), and it is the only PRD in this stack that changes what a human
sees rather than what the engine stores.

The predicate is written **once**, in one exported helper, expressed today on the identity **columns**
of `contacts`. PRD 02/03 replace that helper's body with a `contact_aliases` `EXISTS` — one function
body, no call-site churn.

## Locked decisions

### The predicate, and where it lives

- **"Identified" today is a four-column disjunction, not two.** The brief said "an `external_id` or
  `email` present". That is wrong by two columns: `contacts.discord_id`
  (`packages/db/src/schema/contacts.ts:43`) and `contacts.phone` (`:53`) are both documented in the
  schema as *resolvable identity keys, NOT properties*, each with its own live partial-unique index
  (`:108-113`). A Discord-linked community member or an SMS-only subscriber has identified. The
  predicate is:

  ```sql
  external_id IS NOT NULL OR email IS NOT NULL OR discord_id IS NOT NULL OR phone IS NOT NULL
  ```

- **It lives in ONE exported helper** in `packages/engine/src/lib/contacts.ts`, immediately beside
  the existing `contactSearchFilter` (`:257-264`), which is the established idiom for "a reusable
  Drizzle predicate over `contacts`". Name: `identifiedContactFilter()`. The complement is
  `not(identifiedContactFilter())` — safe under three-valued logic because every operand is
  `IS NOT NULL`, which never yields NULL, so `NOT` can never swallow a row. The `EXISTS` form PRD 02
  swaps in has the same property.

- **The PRD 02/03 change is exactly this one function body:**

  ```ts
  or(
    sql`exists (select 1 from contact_aliases ca
                where ca.contact_id = ${contacts.id} and ca.alias_kind <> 'anonymous')`,
    isNotNull(contacts.phone),
  )
  ```

  **The `phone` leg is NOT redundant and must survive the swap.** PRD 02 deliberately excludes
  `phone` from both the alias backfill and the dual-write (phone is out of scope per BACKLOG — SMS
  identity has its own open design and `contacts.phone` is not yet a merge-participating `Kind`).
  So a phone-only contact has NO non-anonymous alias row, and a pure `EXISTS` swap would silently
  reclassify every one of them as never-identified and drop it out of Studio's default list —
  regressing this PRD's own acceptance criterion. The leg retires only when phone joins the identity
  table, not before.

  `contact_aliases` already has `(alias_kind, alias_value)` unique and `contact_id` indexed
  (`packages/db/src/schema/contact-aliases.ts:35-39`), so the `EXISTS` is index-served. **Do not
  make that swap in this PRD.** Today the table is populated only on merge/promote (its own doc
  comment, `:5-12`), so the `EXISTS` form would currently hide almost everyone. It becomes correct
  only after PRD 02's backfill is verified.

- **"Anonymous" means "never identified", which is the exact complement.** It therefore also
  captures the rare keyless row — the engine already acknowledges those exist and handles them by
  uuid (`routes/admin/contacts.ts:526-528, 544-558`). Not calling that out would leave a class of row
  invisible under both filter values, which is worse than a slightly loose label.

### Where the toggle lives, and what defaults

- **The server default does NOT change.** `GET /v1/admin/contacts` gains
  `identity: "all" | "identified" | "anonymous"`, **default `"all"`**. Two consumers other than the
  contacts list call this endpoint, and neither should silently change:
  - `packages/cli/src/commands/contacts.ts:216-226` — `hogsend contacts list`, a published CLI whose
    output is scripted against.
  - `packages/studio/src/components/contact-picker.tsx:66-72` — the registry picker; an anonymous
    contact is a legitimate pick when a journey/test is being aimed at an anon key.

  Only `ContactsView` opts in. That is what makes this a *display* concern rather than an API
  behaviour change, and it is what keeps the two tasks additive-then-flip: T1 adds a parameter no
  one sends, T2 sends it from exactly one screen.

- **Three values, not a boolean.** The operator who is debugging ghost growth wants to see the
  anonymous tail *alone*, not merged back into everything. `?identity=anonymous` is the surface the
  original complaint actually needed.

- **Count and pagination stay correct for free.** The route builds one `where` (`:381-387`) and feeds
  it to BOTH the page query and the `count()` (`:389-398`), then returns `total` from the same filter
  (`:400-408`). Adding one more conjunct keeps them in lockstep. This is not an accident to rely on
  silently — T1's test asserts `total` equals the identified fixture count and NOT the seeded total,
  which is the assertion that fails if someone later filters the rows but not the count.

  Worth recording honestly: **Studio has no pagination today.** `listContacts`
  (`packages/studio/src/lib/admin-api.ts:1001-1018`) never sends `offset`, and `ContactsView` renders
  one 50-row page with no pager. So the filter cannot skew a page-2 boundary in Studio; it just makes
  page 1 useful. The CLI *does* send `offset` (`cli/src/commands/contacts.ts:216-220`) and defaults
  to `identity=all`, so its paging is untouched.

### What is deliberately NOT filtered

- **`GET /v1/admin/contacts/export`** (`packages/engine/src/routes/admin/bulk.ts:88-111`) stays
  unfiltered. An export is a data dump, not a display; quietly dropping rows from someone's CSV is a
  data-loss-shaped bug.
- **The dashboard `totalContacts` tile** (`routes/admin/metrics.ts:303-317, :387` — `count()` over
  every live row) stays as-is. Changing it is a second read flip in the same PRD, which DECISIONS §4
  forbids. It does create a visible discrepancy (dashboard says 18,000, list shows 400), which is
  precisely why T4 exists: the list itself reports both numbers, so the operator is never left
  guessing which one lied.
- **`allowCreate` and the #621 refusal sites** are untouched (BACKLOG "Out of scope"). This PRD makes
  them unnecessary *for the display problem*; it does not make them wrong.

## EARS acceptance criteria

- **WHEN** `GET /v1/admin/contacts` is called with no `identity` parameter, the system **SHALL**
  return exactly the rows and `total` it returned before this change.
- **WHEN** `GET /v1/admin/contacts?identity=identified` is called, the system **SHALL** return only
  contacts having at least one of `external_id`, `email`, `discord_id`, `phone`, and **SHALL** report
  a `total` equal to the number of such contacts matching the other filters.
- **WHEN** `GET /v1/admin/contacts?identity=anonymous` is called, the system **SHALL** return exactly
  the complement of the `identified` set under the same other filters, so that
  `total(identified) + total(anonymous) === total(all)`.
- **WHEN** a contact holds only a `discord_id` (or only a `phone`) and no `external_id`/`email`, the
  system **SHALL** classify it as identified.
- **WHEN** `identity` is combined with `search`, `minRevenue`, `dealStage`, `propertyKey`/
  `propertyGte` or `orderBy=property`, the system **SHALL** apply all of them conjunctively and
  **SHALL NOT** change the ordering semantics of any of them.
- **WHEN** `identity` is given a value outside the enum, the system **SHALL** respond 400.
- **WHEN** the Studio contacts list first loads, the system **SHALL** request `identity=identified`
  and **SHALL** show a visible control stating that anonymous visitors are hidden.
- **WHEN** the operator switches that control to "Never identified", the system **SHALL** re-query
  with `identity=anonymous` and render the anonymous tail, without a full page reload.
- **WHEN** a search under `identity=identified` returns zero rows, the system **SHALL** offer a
  one-click action that re-runs the same search across all contacts.
- **WHEN** `identity=identified` is in effect, the system **SHALL** display how many contacts are
  hidden by that filter (T4), so the list total and the dashboard's `totalContacts` are reconcilable.

## Tasks

### T1 — `identifiedContactFilter()` + the `identity` query parameter (additive; no consumer sends it)
_Boundary:_ `packages/engine` · _Depends:_ —

Add `identifiedContactFilter()` to `packages/engine/src/lib/contacts.ts` beside `contactSearchFilter`
(`:257-264`), exported from the package index alongside it. JSDoc must state, in the file's existing
register: (a) the four columns and why `discord_id`/`phone` count, (b) that PRD 02 replaces the body
with the `contact_aliases` EXISTS and that doing so before the backfill hides everyone.

In `packages/engine/src/routes/admin/contacts.ts`, add `identity: z.enum(["all","identified",
"anonymous"]).default("all")` to the `listRoute` query schema (`:82-116`), and one conjunct to the
existing `where` composition (`:381-387`) — nothing else in the handler moves. Update the route
`summary`/OpenAPI description so the parameter is discoverable in `/docs`.

**How it is tested.** New `apps/api/src/__tests__/contacts-identity-filter.test.ts`, modelled on
`contact-leaderboard.test.ts` (real Postgres, run-scoped `RUN` prefix, swept in `afterAll` — read its
header comment first, including the `HOGSEND_TEST_DATABASE_URL` warning). Seed five fixtures under one
run prefix: external-id-only, email-only, **discord-id-only**, **phone-only**, and anonymous-id-only.
Then assert:

1. no `identity` → all five, `total === 5`;
2. `identity=identified` → four rows AND `total === 4` (this is the count-consistency assertion —
   it is the one that fails if the count query loses the conjunct);
3. `identity=anonymous` → exactly the one anon fixture;
4. the two totals sum to the unfiltered total;
5. `identity=identified&orderBy=property&orderProperty=…` still ranks correctly (composition);
6. `identity=bogus` → 400.

**Mutation proof** (per `reference_vacuous-green-tests`): dropping **any single operand** from the
disjunction must turn assertion 2 red — run it four times, once per column. `discord_id` and
`phone` are the two that matter most: they are the legs a reader is most likely to think redundant,
and `phone` is the one PRD 02's `EXISTS` swap would silently drop (it is deliberately absent from the
alias backfill). If removing an operand leaves the suite green, the fixture set is wrong, not the
predicate.

### T2 — Studio contacts list defaults to identified, with a toggle
_Boundary:_ `packages/studio` · _Depends:_ T1

`packages/studio/src/lib/admin-api.ts`: add `identity?: "all" | "identified" | "anonymous"` to
`ContactListFilters` (`:981-999`) and forward it in `listContacts` (`:1001-1018`). `qk.contacts`
(`:2211`) already keys on the whole filters object, so the react-query cache varies automatically —
no cache-key work.

`packages/studio/src/views/contacts-view.tsx`: add `const [identity, setIdentity] =
useState<"identified"|"anonymous"|"all">("identified")`, put it in the `filters` object (`:67-80`),
and add a `<Select>` to the filter bar (`:96-141`) mirroring the deal-stage select's markup exactly
(`:118-130`) — labels "Identified only" / "Never identified" / "All contacts". Update the
`EmptyState` (`:147-155`): when `identity === "identified"` and a `search` returned nothing, pass an
`action` button (the component already supports one — `components/states.tsx:31-57`) that calls
`setIdentity("all")` and keeps the search term. This matters because `contactSearchFilter` searches
`anonymous_id` (`lib/contacts.ts:261`), so pasting an anon id into the box under the default filter
returns nothing and looks broken.

Do **not** touch `contact-picker.tsx` — it keeps the server default.

**How it is tested.** `packages/studio` has no test runner (`package.json` scripts: `dev`/`build`/
`check-types` only), so the honest verification is: `pnpm --filter @hogsend/studio check-types`, then
the real UI per the `verify` skill — run the engine API against a local DB seeded with a mixed
identified/anonymous set (T1's fixtures are reusable), open Studio, and screenshot all three toggle
positions plus the zero-result search escape hatch. Per `feedback_no-artifacts-run-real-ui`: the real
app, not a mockup, and the preview goes in the PR before merge.

### T3 — docs + changeset
_Boundary:_ `apps/docs` + `.changeset` · _Depends:_ T1

`apps/docs/content/docs/operating/contacts.mdx` "Listing and Searching Contacts" (from `:32`): add
the `identity` parameter with a curl example for `identity=anonymous`, and state that the default is
`all` so scripted callers know nothing moved. While in the file, fix the adjacent inaccuracy at
`:53` — it claims `search` matches "both `email` and `externalId`", but `contactSearchFilter`
(`lib/contacts.ts:257-264`) also matches `anonymous_id` and `discord_id`. That is a one-line doc
correction, not a behaviour change.

Changeset: minor on `@hogsend/engine` (new public route parameter + new exported helper) and
`@hogsend/studio`, then `pnpm changeset:engine-line` per DECISIONS §6.

**How it is tested.** `pnpm lint`; `pnpm --filter @hogsend/docs build` (MDX compiles); `pnpm release:check`.

### T4 — report the hidden count (optional, droppable)
_Boundary:_ `packages/engine` (+ a one-line `packages/studio` render) · _Depends:_ T1, T2

Add `hiddenAnonymous: number` to the list response: a second `count()` over the same `where` with the
predicate **inverted**, run in the existing `Promise.all` (`:389-398`), and only when
`identity === "identified"` (otherwise `0`, no extra query). Studio renders it as a line under the
filter bar: *"312 anonymous visitors hidden."*

**Be honest about the cost:** this is a third full `count()` on the contacts table per list request.
Both existing count paths already seq-scan (the `contacts_*_unique_idx` indexes are partial on
`IS NOT NULL` and will not serve an OR-disjunction; the GIN at `schema/contacts.ts:124-127` serves
containment only), so at GTM volume — thousands of rows, the volume the leaderboard comment at
`:330-332` already calls out as the design point — this is cheap, and at analytics volume the whole
route is already the wrong shape. No index is added here; PRD 02's `EXISTS` gets one for free from
`contact_aliases_contact_id_idx`.

**Why keep it:** without it the dashboard tile (all rows) and the list total (identified rows)
disagree with no explanation on screen, which is the same "the CRM is lying to me" feeling this PRD
exists to remove. **Why it is droppable:** it is the only part of this PRD that adds per-request
work, and T1–T3 are complete and shippable without it.

**How it is tested.** Extend T1's test file: with the five fixtures, `identity=identified` returns
`total === 4` and `hiddenAnonymous === 1`; `identity=all` returns `hiddenAnonymous === 0`.

## Risks / how this can go wrong

- **A real customer disappears from the list.** The failure mode is a contact whose only identity
  lives somewhere the predicate does not look. Mitigated by testing all four columns explicitly, and
  bounded by the toggle — nothing is deleted, one dropdown brings it back. The 30-second diagnosis
  for a "where did X go" report is: switch to "All contacts"; if X reappears, the predicate is wrong.
- **The ghost rows from before #621.** A historical row minted with `external_id = <anonId>` (the
  pathological shape named in #621's notes) reads as *identified* and will still show. This PRD does
  not clean those up — DECISIONS §4 forbids bundling behaviour with a step like this, and BACKLOG
  puts anonymous-row cleanup out of scope. Expect the identified count to be slightly inflated on
  deployments that ran the old code; say so in the changeset rather than letting an operator discover
  it.
- **Search feels broken under the default.** Covered by T2's empty-state escape hatch; the risk if
  T2's `action` is skipped is a support ticket, not data loss.
- **Someone "helpfully" flips the server default to `identified`.** That silently changes
  `hogsend contacts list` and the picker. The route's Zod default and its JSDoc must say why it is
  `all`; the CLI is a published surface.
- **Premature use of the `contact_aliases` EXISTS.** If PRD 02 lands the swap before its backfill,
  the list empties. Guarded by naming the ordering explicitly in the helper's JSDoc — PRD 02 must
  swap the body only after its backfill verification step.
- **Count/page divergence.** Only possible if a future edit filters `rows` without filtering the
  `count()`. Pinned by T1 assertion 2.

## Rollback

- **T1 (engine).** The parameter defaults to `all`, so an engine rollback is a no-op for every
  caller that does not send it. If the predicate itself is wrong in production and a redeploy is not
  immediate, the operator's own mitigation is the toggle. There is **no migration and no schema
  change in this PRD**, so rollback is a plain revert with no data step.
- **T2 (studio).** Change one initial `useState` from `"identified"` to `"all"` and Studio behaves
  exactly as it does today; the toggle stays available. This is the fastest kill switch and does not
  require an engine deploy.
- **T4.** Delete the extra `count()` and the response field; it is additive and unread by any other
  consumer.
- Full stack revert: `git revert` the PR. Nothing downstream stores or derives from `identity`.

## Done when

- `identity` exists on `GET /v1/admin/contacts` with a default that leaves the CLI and the contact
  picker byte-identical, and the OpenAPI doc shows it.
- The predicate exists exactly once, as an exported helper, with the PRD 02 swap written into its
  JSDoc.
- T1's test file is green, and removing `discord_id` from the disjunction turns it red.
- `total(identified) + total(anonymous) === total(all)` holds in test.
- Studio opens on identified-only, the toggle shows the anonymous tail, and a zero-result search
  offers the all-contacts escape.
- Screenshots of the three toggle states from the REAL Studio are in the PR.
- DECISIONS §5 gates pass verbatim:
  ```
  pnpm lint
  pnpm exec turbo run check-types --concurrency=2
  cd apps/api && HOGSEND_TEST_DATABASE_URL=postgresql://growthhog:growthhog@localhost:5434/ghost_clean pnpm exec vitest run
  cd packages/engine && pnpm test
  ```
- Changeset present; `pnpm changeset:engine-line` run.

## Implementation Notes

Shipped `07381543`. `GET /v1/admin/contacts` gained an `identity` filter
(`all | identified | anonymous`); Studio's contacts view opts in to `identified`. The route default
stays `all`, so the published `hogsend contacts list` CLI and the contact picker are unchanged.

**Divergence from spec — the predicate is four columns, not two.** Plan-critique finding #3 caught
that `external_id`/`email` alone would hide a Discord-only community member and an SMS-only
subscriber, both of which the schema documents as resolvable identity keys with their own
partial-unique indexes. `identified` is therefore
`external_id IS NOT NULL OR email IS NOT NULL OR discord_id IS NOT NULL OR phone IS NOT NULL`.
Every operand is `IS NOT NULL`, so the negation is exact under three-valued logic and the two
filters are true complements — no contact can fall through both.

The predicate and the `count` share one `where` clause, so the total can never disagree with the
rows returned.

`contacts-identity-filter.test.ts` (7 tests). One seeds a contact per identity column and asserts
all four appear under `identified`, so dropping any operand fails a named test rather than silently
hiding real customers.

Studio's empty state distinguishes an empty CRM from an active filter, and a search returning
nothing under the default offers to widen itself — search also matches anonymous ids, so a
zero-result search under `identified` is usually a filter artefact, not an absence.
