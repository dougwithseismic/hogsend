# PRD 08 — `contact.refined` outbound event (optional, cuttable)

**Depends on:** PRD 03 · **Status:** `[ ]`

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

_(filled in during build)_
