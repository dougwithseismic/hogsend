# BACKLOG — deep PostHog integration

Ordered queue. Build top-down; dependencies come first.

**Status as of 2026-07-28: the cohort chain is parked and PRD 04 is cut.** P0, PRD 00 and
PRD 01 shipped and stay on `feat/posthog-deep-integration`. PRD 02's implementation was
reverted off the branch and lives only on **`parked/posthog-cohort-sync`**
(`b2ada111^..1d7d91db`). PRD 03 is blocked behind it. Reasoning is in `DECISIONS.md` §8;
the design rule the review produced is §9. Nothing below 02 in the queue that depends on
the cohort chain is startable; 05, 06 and 08 do not depend on it and are.

## Prerequisite — `P0`: move `createRateLimitedFetch` into `@hogsend/core`

**Status:** `[x]` SHIPPED `f4419e26` · **Blocks:** 02 (T02.1), 05 (T05.1), 06 (T06.1)

Not part of any PRD, and every PRD that talks to PostHog needs it. DECISIONS §2.10 locks
it: `createRateLimitedFetch` lives in `packages/cli/src/lib/import-shared.ts:96-148`, and
neither `plugin-posthog` nor `engine` may import from `@hogsend/cli` — that is a workspace
dependency cycle which under pnpm either fails to build or produces a nondeterministic
tsup bundle. Mandating reuse from where it sits would block the first task of the headline
PRD on a refactor nobody owns; the likely improvisation is three slightly-different
limiters.

Move it to `@hogsend/core` (cycle-free: both `plugin-posthog` and `engine` already depend
on core, and core depends on neither), with `packages/cli` re-exporting for back-compat.
Small and standalone — whichever of 02/05/06 lands first pulls it forward.

| # | PRD | Status | Depends on | Scope |
|---|-----|--------|-----------|-------|
| 00 | [posthog-identity-map](prds/00-posthog-identity-map.md) | `[x]` | — | Give a PostHog `person_id` a mapped-alias home so every downstream feature has a stable, idempotent PostHog↔Hogsend key |
| 01 | [manual-bucket-membership](prds/01-manual-bucket-membership.md) | `[x]` | — | Unlock `BucketMeta.kind: "manual"` end-to-end plus a guarded membership-write path. Standalone engine capability, no PostHog code |
| 02 | [posthog-cohort-sync](prds/02-posthog-cohort-sync.md) | `[~]` | P0, 00, 01 (**T01.3 hard**) | **PARKED 2026-07-28.** Built, reviewed, reverted off the branch; lives on `parked/posthog-cohort-sync` (`b2ada111^..1d7d91db`). Poll PostHog cohorts, diff on `person_id`, drive joins/leaves through PRD 01's `addBucketMember`/`removeBucketMember` |
| 03 | [cohort-loop-guard](prds/03-cohort-loop-guard.md) | `[~]` | 02 (T02.1, T02.2, T02.4) | **BLOCKED by 02's parking.** Nothing to guard until the cohort import exists. Provenance registry, enforced at binding activation + every tick — **not at boot** |
| 04 | [cohort-trigger-sugar](prds/04-cohort-trigger-sugar.md) | `[-]` | 02 | **CUT 2026-07-28**, not deferred. `trigger: { cohort: "..." }` desugaring. The magic string that started the review; the cohort trigger is not shipping |
| 05 | [posthog-codegen](prds/05-posthog-codegen.md) | `[ ]` | P0 (credentials only otherwise) | `hogsend posthog generate` → committed `.d.ts` for event names, properties, cohort ids, flag keys; `--check` for drift |
| 06 | [retroactive-enrollment](prds/06-retroactive-enrollment.md) | `[ ]` | P0, 00 | `hogsend backfill --since 90d`, dry-run by default (find-only resolve), age cutoff, scope-independent `posthog:<uuid>` idempotency. **T06.0 stamps that key on the real-time webhook path first** |
| 07 | [posthog-engagement-writeback](prds/07-posthog-engagement-writeback.md) | `[~]` | 00, 03 | **BLOCKED behind 03.** Write engagement back as `hogsend_*` person properties, batched, so PostHog funnels and replays are annotated |
| 08 | [posthog-surveys-triggers](prds/08-posthog-surveys-triggers.md) | `[ ]` | 00 | PostHog survey responses as journey triggers via the existing webhook loop |
| 09 | [hogsend-audience-to-cohort](prds/09-hogsend-audience-to-cohort.md) | `[~]` | 07 | **DEFERRED** by decision 2026-07-27. Push a bucket out as a PostHog static cohort |
| 10 | [posthog-distribution](prds/10-posthog-distribution.md) | `[~]` | 02, 04 proven stable | **DEFERRED HARD, and its entry conditions are now unreachable** — 02 is parked and 04 is cut. CDP catalog listing + community docs tutorial. Outward-facing, needs explicit approval |

## Legend

- `[ ]` not started
- `[~]` in progress, or deferred/parked/seam-blocked
- `[x]` shipped
- `[-]` cut — a decision was taken not to build it. Not a queue item

## Sequencing notes

**00 and 01 are foundational and were not in the original brief.** 01 in particular is a
standalone engine capability with independent value — CSV audience import, admin tagging,
SDK-driven audiences — and can ship as its own release even if the PostHog work slips.
Shipping it first makes the cohort sync a thin plugin on top of a proven engine primitive,
which is the posture that keeps PostHog non-load-bearing. That sequencing is what made the
parking decision cheap: 00 and 01 stand without 02.

**02 and 03 ship together, and both are now off the queue.** Splitting them was a
documentation convenience, not a shipping boundary — cohort sync without the loop guard is
a slow oscillator waiting to happen — so parking 02 parks 03 with it. Resuming means
resuming both, from `parked/posthog-cohort-sync`.

**05 has zero runtime coupling to the cohort chain** and can jump the queue if an early
visible win is wanted — but the "zero dependencies" reading was too strong: its paged
definitions fetch needs the rate-limited PostHog client, so it depends on **P0**, not on
PRD 02's cohort client. P0 has shipped, so the dependency is already satisfied and 05 is
startable now. It exercises the OAuth credential path end-to-end, which makes it a useful
integration smoke test for everything after it.

**The `import_jobs` cursor column is settled.** It was a shared prerequisite of 02 and 06,
and PRD 00 T00.1 hoisted it so 06 could ship before 02 — which is now the only order
available. It is in the tree; nothing is owed here.

**T06.0 is a cross-package edit with two copies.** Stamping `posthog:<uuid>` on the
real-time webhook source must land in BOTH `apps/api/src/webhook-sources/posthog.ts` and
`packages/create-hogsend/template/src/webhook-sources/posthog.ts`. Fixing only the dogfood
consumer ships a scaffold whose backfill silently double-sends.

**09 and 10 are deferred, not cut.** 09 was deferred behind 07 because writeback alone
delivers most of its value with none of the export/import cycle risk. 10 is a public
commitment to stability for a feature whose worst failure mode is slow and hard to detect;
dogfood first. 10's entry conditions are now unreachable, since they name 02 and 04.

**07 is blocked by 03's blocking.** It depends on 00 and 03, and 03 is parked with 02. Its
person-property writes are the largest single input to the feedback loop 03 exists to cut,
so shipping it without the guard inverts the reason the dependency was written.

**Two items lost their owner when 02 was parked, and both are in shipped code.** Neither
needs PostHog to reproduce, so neither should wait on a resumption that may not come:

1. **The `emit: false` maxDwell gap** (PRD 01 Implementation Notes). The maxDwell TTL pass
   runs before the pending-leave pass and does not exclude rows carrying a silent pending
   leave, so a bucket with both `maxDwell` and `minDwell` can emit a `bucket:left` for a
   leave requested silently. It was booked to be fixed "when PRD 02 wires seeding".
2. **PRD 03 T03.0** — determine whether the already-shipped `syncToPostHog` mirror can
   self-sustain a loop with no cohort import at all. If it can, that is a live bug today.

## Cut from scope

Recorded in `DECISIONS.md` §3: cohort *definition* translation, PostHog flags as journey
conditions, virtual-clock backfill, sub-5-minute cohort latency.

Recorded in `DECISIONS.md` §8, 2026-07-28: **PRD 04** (`cohort-trigger-sugar`) and the
**`AudienceSource`** descriptor. `AudienceSource` existed solely to replace the cohort
binding's raw `cohortId: number`; with the cohort bet parked it has zero consumers.
