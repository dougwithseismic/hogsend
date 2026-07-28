# PRD 07 — `posthog-engagement-writeback`

**Depends on:** 00, 03. **Status:** `[~]` BLOCKED, 2026-07-28 — PRD 03 is blocked behind
PRD 02's parking (`DECISIONS.md` §8), and the 03 dependency below is the load-bearing kind.

> This PRD is the single largest source of person-property writes in the product and it
> depends on 03's provenance registry, namespace-forcing and fuse existing first. Shipping
> it while 03 is unbuilt inverts the reason the dependency was written. Note that 03's
> return leg is currently absent — no cohort import exists to re-read these keys — so the
> loop cannot close today; that is a property of the parking, not a reason to drop the
> dependency, because it re-closes the moment `parked/posthog-cohort-sync` is resumed.

## Goal

Write Hogsend engagement — sent, opened, clicked, journey enrollment state — back as
PostHog person properties, so PostHog funnels and session replays are annotated by
Hogsend. Their dashboards visibly improve because Hogsend is installed.

This is the "everywhere" half of the strategy, rendered inside PostHog's own product.

## Why it depends on PRD 03

The fuse and the namespace discipline must exist **before** this ships. This PRD is the
single largest source of person-property writes in the product, and every one of them is a
potential input to a PostHog cohort that PRD 02 might then import.

## Locked decisions

- **All written properties live under the reserved `hogsend_*` prefix**, extending the
  convention `bucket-posthog-sync.ts:40-41` already establishes.
- **Every key written here MUST be registered in PRD 03's provenance registry**
  (DECISIONS §2.5). PRD 03's cohort-binding refusal keys off that registry, **not off the
  `hogsend_*` prefix** — a prefix check is evadable via custom `postHogPropertyKey`s and
  direct `identify()` calls, so the registry is the load-bearing artefact and the prefix is
  the convention that makes populating it easy. Adding a writeback property without
  registering it silently reopens the feedback loop this stack exists to close; PRD 03's
  namespace-forcing on `setPersonProperties` is what makes that hard to do by accident.
- **Batching is mandatory, not an optimisation.** Every open and click would otherwise
  become a PostHog capture; a single campaign send would double a customer's PostHog event
  volume and their bill. Aggregate per contact per window, flush periodically.
- Reuse the engine's existing emit points rather than adding new hooks: the tracked mailer
  (`packages/engine/src/lib/mailer.ts`) and the tracking routes
  (`routes/tracking/click.ts`, `routes/tracking/open.ts`).
- Off by default, per-deployment opt-in, consistent with `syncToPostHog`.
- Degrades to a documented no-op with no PostHog credential.

## Acceptance criteria (EARS)

1. WHEN an email is sent and writeback is enabled, the system SHALL record engagement
   state for that contact under a `hogsend_*` property.
2. WHEN multiple engagement events occur for one contact inside the batch window, the
   system SHALL emit at most one PostHog write for that contact per window.
3. WHEN writeback is disabled or no credential exists, the system SHALL perform no writes
   and SHALL NOT throw.
4. WHEN a write fails, the system SHALL log and swallow, and SHALL NOT block the send,
   the click redirect, or the open pixel.
5. WHEN the PRD 03 per-contact fuse is exceeded, writes SHALL be dropped and logged.
6. WHEN a contact is merged, engagement writeback SHALL follow the survivor.

## Tasks

### T07.1 — Batching layer
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ —

Per-contact per-window aggregation with periodic flush. Satisfies AC 2. Must be safe
across the separate API and worker processes.

### T07.2 — Emit points
_Boundary:_ `packages/engine/src/lib/mailer.ts`, `routes/tracking/` · _Depends:_ T07.1

Hook the existing send/open/click paths. Fire-and-forget; never on the critical path of a
redirect or pixel response (AC 4).

### T07.3 — Property schema + journey state
_Boundary:_ `packages/engine/src/lib/` · _Depends:_ T07.1

Define exactly which `hogsend_*` properties are written and their semantics, **and
register every one of them in PRD 03's provenance registry** (T03.1a) — that registration
is part of this task's definition of done, not a downstream concern. Document them —
operators will build cohorts on these, and PRD 03 will then refuse those cohorts, which
must be an *understood* interaction rather than a surprise.

Test the seam directly: a cohort filtering on a writeback key defined here is refused by
PRD 03's walker. If PRD 03 has not shipped when this task runs, write the registration and
leave the assertion as a pending test rather than skipping it.

## Seams

Verifying that PostHog funnels genuinely improve requires a real project with real replay
data. Enumerate as a human verification step.

## Done when

All ACs pass, gates green, and a real send demonstrably annotates a PostHog person with
batched engagement state, with a documented list of the properties written.

## Implementation Notes
