# PRD 08 — `contact.refined` outbound event (optional, cuttable)

**Depends on:** PRD 03 · **Status:** `[x]`

## Goal

Let refined traits reach a CRM or warehouse without authoring a journey, by adding `contact.refined`
to the outbound webhook catalog.

**This PRD is explicitly cuttable.** If the run is long or anything upstream is unstable, drop it —
nothing depends on it.

## Locked decisions

- The catalog is vendored into **two hand-synced copies with no drift check**. All three must be
  edited together:
  1. `packages/engine/src/lib/webhook-signing.ts` — `WEBHOOK_EVENT_TYPES` (the source of truth)
  2. `packages/cli/src/commands/webhooks.ts` — the CLI's `const WEBHOOK_EVENT_TYPES`
  3. `packages/client/src/types.ts` — the `OutboundEventType` string union
- Emission goes through the existing `emitOutbound` spine with a `dedupeKey` derived from the ledger
  row, so a re-drive does not double-deliver.
- Emit from `refineContact` **only on a genuine `status: "refined"`** — never on `cached`,
  `not_found`, or `skipped`. A cache hit is not an event.

## Acceptance criteria (EARS)

1. WHEN a refinement completes with `status: "refined"` the system SHALL emit `contact.refined` with
   the contact key, provider id, and the mapped trait keys.
2. WHEN a refinement returns `cached`, `not_found`, or `skipped` the system SHALL NOT emit.
3. WHEN the same refinement is re-driven the system SHALL NOT produce a second delivery for the same
   endpoint (dedupe key holds).
4. WHEN `WEBHOOK_EVENT_TYPES` is compared against the CLI and client copies all three SHALL contain
   `contact.refined`.

## Tasks

### T8.1 — Catalog + emission
_Boundary:_ `packages/engine` (+ the two vendored copies) · _Depends:_ PRD 03

Add the event type to all three catalogs, the payload type to `OutboundPayloads`, and the
`emitOutbound` call to `refineContact`.

_Test:_ AC 1–3 behaviourally; AC 4 as an explicit cross-file assertion so the next person gets a
failing test instead of silent drift.

## Seams

None.

## Done when

Four acceptance criteria pass and gates are green — or the PRD is deliberately cut and marked as such
in `BACKLOG.md`.

## Implementation Notes

Shipped in `11189192`. Not cut.

**Catalogs** — all three carry `contact.refined`: `webhook-signing.ts` (source of truth),
`packages/cli/src/commands/webhooks.ts`, `packages/client/src/types.ts`. AC 4's test compares them
as FULL SETS rather than just asserting the new entry is present, so it catches every future drift
rather than only this one.

**Payload** — the contact key, the provider id, and the mapped trait NAMES. Not the values: the
payload says what changed, and a subscriber that wants the values reads the contact.
`REFINED_META_KEYS` names `refined_at`/`refined_provider` once so provenance can be told apart from
vendor facts without re-listing them and drifting.

**Emission point** — inside the gate closure, on the already-decided `refined` verdict, after every
stateful step. It issues no durable call, so the journal is byte-identical with and without it
(verified: the `memoize`/`registerKey`/`deriveJourneyKey` grep on the diff is empty, and the law
harness asserts journal identity on every verdict). The dep is `void`-returning by contract, so an
outbound problem can never slow or fail a refinement.

**AC 2 coverage** — all EIGHT non-refined paths asserted in one table (`cached`, ledger `not_found`,
live `not_found`, and all five `skipped` reasons), each with `assert.deepEqual(h.emits, [])`, plus a
control on the same harness shape that DOES emit. Without the control the whole table could pass for
a trivial reason.

**The dedupe key needed the lookup instant, and that was a real find.** The first implementation
derived it from the ledger triple `(provider, lookupKind, lookupKey)` alone. But `webhook_deliveries`
carries a PERMANENT unique `(endpointId, dedupeKey)` index and nothing ever deletes a delivery row.
So a contact refined today and re-refined in 90 days — TTL expired, vendor reports a new job title —
would recompute a byte-identical key and the subscriber would **never be told**, which is precisely
the event a CRM sync exists to receive. Same for any `force: true` refresh. The instant costs nothing
on the re-drive side, because the re-drive is defended by the LEDGER GATE (a retry finds the row the
first attempt wrote, returns `cached`, and never reaches the emit), not by the key.

**Mutation-verified**, not assumed:

| Mutation | Result |
| --- | --- |
| let `not_found` fall through to the emit | 1 test fails |
| strip the instant from the dedupe key | 3 tests fail |

Engine tests 83 → 94. Gates: lint clean (13 pre-existing warnings), check-types 50/50, build 27/27.

**Consumer fallout, deliberate.** A 31st event broke two `apps/api` snapshots that hardcoded the
catalog at 30 (`outbound-webhooks-signing.test.ts`, `impact-digest.test.ts`). Those tests exist to
fail exactly here; the counts moved to 31 in the assertions AND in the test names.
