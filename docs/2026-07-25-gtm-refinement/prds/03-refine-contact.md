# PRD 03 — `refineContact()`

**Depends on:** PRD 01, PRD 02 · **Status:** `[ ]`

## Goal

The one new public function of this release. Resolves a contact, spends at most one provider lookup,
and lands the result as flat contact properties **through `ingestEvent`** so bucket membership
re-evaluates synchronously and the GTM loop closes.

## Locked decisions

- **Standalone import from `@hogsend/engine`, never on `ctx`** (DECISIONS §3.1). Mirrors
  `lib/email.ts` `sendEmail()` and `lib/sms.ts` `sendSms()`.
- **THE LAW: the durable call is issued UNCONDITIONALLY.** The Hatchet journal is positional, so
  `boundary.memoize` must never be conditional on a live DB read — see the law as written in
  `packages/engine/src/lib/feed.ts:152-165`, and the corrected pattern in
  `packages/engine/src/lib/connector-actions.ts:320-381`. Every gate verdict is computed **inside**
  the memo closure so it is recorded and replayed verbatim. This is not optional and it is not a
  performance trade-off — an early return before `memoize` shifts the journal and Hatchet kills the run.
  Refinement is the *worst* case for this: the ledger gate reads a row that this function's own final
  step wrote, so a replay diverges every single time rather than racily.
- Cheap-before-spend ordering still holds, but **inside** the closure. That ordering was never the
  problem; its position relative to `memoize` was.
- **The ingest is the last step and is what closes the loop** — `resolveOrCreateContact` alone does
  not re-run `checkBucketMembership` (DECISIONS §3.3).
- Written trait keys are **flat, top-level, `refined_`-prefixed** (DECISIONS §3.4). `employeeCount`
  is written as a JSON **number**; everything else as a string. Undefined fields are omitted entirely
  — never written as `null`, because `mergePropertiesSql` wraps the patch in `jsonb_strip_nulls` and a
  null would *delete* a previously-good key.
- Replay-safety is two-layer, exactly like the mailer: Layer 1 the Hatchet `memo` keyed by
  `deriveJourneyKey({ kind: "refine", … })` when a journey boundary exists; Layer 2 the
  `enrichment_lookups` unique index always. Outside a journey, Layer 2 alone carries it.
- The function **never throws on a provider failure**. A vendor 5xx writes an `error` ledger row and
  returns `{ status: "skipped", reason: "provider_error" }`. Refinement failing must never fail the
  journey run or the ingest that triggered it.

## Signature

```ts
refineContact(opts: {
  userId?: string;
  email?: string;
  contactId?: string;
  provider?: string;          // override the active provider
  force?: boolean;            // bypass TTL + negative cache (still respects the budget cap)
  idempotencyLabel?: string;  // disambiguate two refine sites under one wait label
}): Promise<{
  status: "refined" | "cached" | "not_found" | "skipped";
  reason?: string;
  properties?: Record<string, unknown>;
}>
```

## Gate chain (fixed order)

Copy the structure of `packages/engine/src/lib/connector-actions.ts:320-381` — read it before writing
a line of this function. Two checks outside the memo — one on the ARGUMENTS, one on boot config —
and everything stateful, including resolving the contact, inside it.

**Outside the memo** (an early return here is safe only because neither reads the database, so
neither can change between a run and its replay):

0. **Pure argument check** — `opts.contactId`, `opts.email` and `opts.userId` all absent → there is
   nothing to refine and nothing to key from: `{ status: "skipped", reason: "no_lookup_key" }`, zero
   spend, zero queries.
1. **No active provider** → `{ status: "skipped", reason: "no_provider" }`, zero spend.

**Then, unconditionally** — before any live DB read — when a journey boundary exists: let
`callerRef = opts.contactId ?? normalizeEmail(opts.email) ?? opts.userId`, derive
`deriveJourneyKey({ kind: "refine", anchor: boundary.runAnchor, site: idempotencyLabel ??
boundary.currentLabel ?? callerRef, discriminant: callerRef })`, call `registerKey(boundary, key)`,
and issue `boundary.memoize([key], …)`. No condition may guard this call.

`callerRef` is the caller's own AUTHORED argument, never a value resolved off `contacts`. Resolving
the subject is a live read of a row that gains an email routinely — a form fill, an identify, a merge
— and `refineContact` is the one function whose whole purpose is to be called after a wait. Keying on
the resolved lookup key would let a domain→email upgrade mid-sleep re-key the memo AND the
`enrichment_lookups` row, missing both defence layers and charging the vendor twice.

**Inside the memo closure:**

2. **Resolve** the contact and derive `lookupKey`: the email if present, else the company domain.
   No resolvable key → `{ status: "skipped", reason: "no_lookup_key" }`, zero spend. This is a live
   `contacts` read, so its verdict is memo-recorded and replayed verbatim like every other one.
3. **Ledger check** (skipped when `force`) — a row whose `expiresAt` is in the future:
   `status: "found"` → land the row's stored `traits` patch on the contact being asked about (through
   `ingestEvent`, exactly as step 6 does) and return `cached` with that patch; `status: "not_found"`
   → return `not_found`. Both zero spend. A `status: "error"` row does **not** short-circuit.
   The ledger has no contact dimension and a `domain` key is shared by every contact at that company,
   so "this key was already paid for" says nothing about whether THIS contact has the traits — the
   cache suppresses the spend, never the outcome. (Rows written before the `traits` column existed
   have nothing stored and fall back to the caller's own traits.)
4. **Budget cap** — if `ENRICHMENT_MONTHLY_LOOKUPS > 0` and the number of provider LOOKUPS recorded
   in the current calendar month is at or above it →
   `{ status: "skipped", reason: "budget_exceeded" }`. Fails closed. `force` does not bypass this.
   Count lookups, not rows: the ledger is one row per subject and a `force` refresh updates it in
   place, so a row count would leave the refresh path — the only way to re-spend inside the TTL —
   entirely unmeasured. `enrichment_lookups.spend_count` is bumped on EVERY provider call, errors
   included, and resets when a call lands in a new window. (This is a month-to-date total that
   legitimately changes between run and replay — which is exactly why it must live inside the closure
   and be replayed verbatim.)
5. **Provider call** — `provider.enrichPerson(query)`. A throw records the spend (`spend_count` +
   `last_error_at`) WITHOUT clobbering any live cached answer, and returns
   `{ status: "skipped", reason: "provider_error" }`.
6. **Write the ledger row — with the normalized patch — then `ingestEvent`,** in that order:
   `ingestEvent({ event: "contact.refined", userId, eventProperties: { provider, found },
   contactProperties: flattenTraits(result) })`. A failed ingest is caught and returned as
   `{ status: "skipped", reason: "ingest_failed" }`: the paid row is already committed, so letting
   the exception escape would spend the money AND fail the journey run. The retry is free — it hits
   step 3 and re-lands the stored patch.

**With no boundary** (called from a webhook, a cron, or a test) the chain runs directly with no memo —
mirror `connector-actions.ts:341` (`if (!boundary) return gate(doRun)`). Layer 2, the
`enrichment_lookups` unique index, carries exactly-once on its own.

## Trait mapping (`flattenTraits`)

| Result field | Contact property | Type |
|---|---|---|
| `person.title` | `refined_title` | string |
| `person.seniority` | `refined_seniority` | string |
| `person.department` | `refined_department` | string |
| `person.linkedinUrl` | `refined_linkedin_url` | string |
| `person.country` | `refined_country` | string |
| `company.name` | `refined_company_name` | string |
| `company.domain` | `refined_company_domain` | string |
| `company.industry` | `refined_company_industry` | string |
| `company.employeeCount` | `refined_company_employees` | **number** |
| `company.estimatedRevenue` | `refined_company_revenue` | **number** |
| `company.country` | `refined_company_country` | string |
| — | `refined_at` | ISO string |
| — | `refined_provider` | string |

Undefined source fields are omitted from the patch entirely.

## Acceptance criteria (EARS)

1. WHEN `refineContact` is called for a contact with no prior ledger row and a provider returns a
   match the system SHALL return `status: "refined"`, write exactly one ledger row with
   `status: "found"`, and merge the mapped `refined_*` keys onto the contact.
2. WHEN `refineContact` is called a second time for the same lookup key inside the TTL the system
   SHALL return `status: "cached"`, call the provider **zero** times, and leave the ledger row count
   unchanged.
3. WHEN a prior lookup recorded `status: "not_found"` and is unexpired the system SHALL return
   `status: "not_found"` and call the provider zero times.
4. WHEN `force: true` is passed and an unexpired row exists the system SHALL call the provider and
   update the existing ledger row rather than inserting a duplicate.
5. WHEN `ENRICHMENT_MONTHLY_LOOKUPS` is reached the system SHALL return
   `status: "skipped", reason: "budget_exceeded"` and call the provider zero times, even with `force`.
6. WHEN no active enrichment provider is registered the system SHALL return
   `status: "skipped", reason: "no_provider"` and SHALL NOT throw.
7. WHEN the provider throws the system SHALL write a ledger row with `status: "error"`, return
   `status: "skipped", reason: "provider_error"`, and SHALL NOT throw. A subsequent call SHALL
   attempt the provider again.
8. WHEN the provider returns a company employee count the system SHALL write
   `refined_company_employees` as a JSON number such that a bucket with
   `criteria: (b) => b.prop("refined_company_employees").gte(100)` matches.
9. WHEN a result field is absent the system SHALL omit that key from the patch entirely, leaving any
   previously stored value on the contact intact.
10. WHEN `refineContact` completes successfully the contact's bucket membership SHALL have been
    re-evaluated (the write went through `ingestEvent`, not `resolveOrCreateContact`).
11. WHEN a journey boundary is present the system SHALL issue exactly one `boundary.memoize` call
    per invocation **regardless of which gate the chain ultimately returns from** — including
    `cached`, `not_found`, and `budget_exceeded`. Assert this on a spy over the boundary: a run that
    short-circuits at the ledger gate and a run that reaches the provider must produce the SAME
    number of durable calls in the same order. This is the positional-journal law; a test that only
    checks return values will not catch a violation.

## Tasks

### T3.1 — `flattenTraits` + trait mapping
_Boundary:_ `packages/engine` · _Depends:_ PRD 01

Pure function, no I/O. Table above. Test AC 8 and AC 9 in isolation before any DB is involved.

### T3.2 — Ledger accessors
_Boundary:_ source in `packages/engine`; DB-backed tests in `apps/api/src/__tests__/` · _Depends:_ PRD 02

Read/insert/update helpers over `enrichment_lookups`: unexpired-row lookup, upsert-on-conflict
(so AC 4 updates rather than duplicates), and the budget-period count.

**Test placement matters (DECISIONS §4a).** `packages/engine` runs `tsx --test` (node:test) and has
**no live-database harness** — its five existing test files are pure unit tests. Anything touching
Postgres goes in `apps/api/src/__tests__/` under vitest, which is the only suite wired to a real DB.
Do not add a DB harness to `packages/engine`.

_Test:_ AC 1–5 in `apps/api/src/__tests__/`.

### T3.3 — `refineContact()`
_Boundary:_ source in `packages/engine`; DB-backed tests in `apps/api/src/__tests__/` · _Depends:_ T3.1, T3.2

`packages/engine/src/lib/refine.ts`. Assemble the gate chain per the section above. Re-export from
`packages/engine/src/index.ts`. Tests use a deterministic **fake** `EnrichmentProvider` with a call
counter — the "provider called zero times" assertions in AC 2, 3, 5, 6 are the point of this PRD and
must be asserted on that counter, not inferred.

AC 11 (the memo law) is a **pure** test and belongs in `packages/engine` as node:test, using a stub
boundary that records durable calls. It needs no database.

_Test:_ all eleven acceptance criteria. AC 10 asserts via a bucket that flips on a `refined_*` property.

## Seams

None — all tests run against a deterministic fake provider. Apollo arrives in PRD 04.

## Done when

All ten acceptance criteria pass, gates green, and a test proves the full loop: refine → property
written → bucket entered.

## Implementation Notes

_(filled in during build)_
