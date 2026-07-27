# BACKLOG — deep PostHog integration

Ordered queue. Build top-down; dependencies come first.

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
| 02 | [posthog-cohort-sync](prds/02-posthog-cohort-sync.md) | `[ ]` | P0, 00, 01 (**T01.3 hard**) | Poll PostHog cohorts, diff on `person_id`, drive joins/leaves through PRD 01's `addBucketMember`/`removeBucketMember`. Seeds without emitting. Ships **with** PRD 03 |
| 03 | [cohort-loop-guard](prds/03-cohort-loop-guard.md) | `[ ]` | 02 (T02.1, T02.2, T02.4) | Make the property-writeback feedback loop structurally impossible. Provenance registry, enforced at binding activation + every tick — **not at boot**. Ships in the same release as 02 |
| 04 | [cohort-trigger-sugar](prds/04-cohort-trigger-sugar.md) | `[ ]` | 02 | `defineJourney({ trigger: { cohort: "..." } })` desugaring, fail-closed at boot |
| 05 | [posthog-codegen](prds/05-posthog-codegen.md) | `[ ]` | P0 (credentials only otherwise) | `hogsend posthog generate` → committed `.d.ts` for event names, properties, cohort ids, flag keys; `--check` for drift |
| 06 | [retroactive-enrollment](prds/06-retroactive-enrollment.md) | `[ ]` | P0, 00 | `hogsend backfill --since 90d`, dry-run by default (find-only resolve), age cutoff, scope-independent `posthog:<uuid>` idempotency. **T06.0 stamps that key on the real-time webhook path first** |
| 07 | [posthog-engagement-writeback](prds/07-posthog-engagement-writeback.md) | `[ ]` | 00, 03 | Write engagement back as `hogsend_*` person properties, batched, so PostHog funnels and replays are annotated |
| 08 | [posthog-surveys-triggers](prds/08-posthog-surveys-triggers.md) | `[ ]` | 00 | PostHog survey responses as journey triggers via the existing webhook loop |
| 09 | [hogsend-audience-to-cohort](prds/09-hogsend-audience-to-cohort.md) | `[~]` | 07 | **DEFERRED** by decision 2026-07-27. Push a bucket out as a PostHog static cohort |
| 10 | [posthog-distribution](prds/10-posthog-distribution.md) | `[~]` | 02, 04 proven stable | **DEFERRED HARD.** CDP catalog listing + community docs tutorial. Outward-facing, needs explicit approval |

## Legend

- `[ ]` not started
- `[~]` in progress, or deferred/seam-blocked
- `[x]` shipped

## Sequencing notes

**00 and 01 are foundational and were not in the original brief.** 01 in particular is a
standalone engine capability with independent value — CSV audience import, admin tagging,
SDK-driven audiences — and can ship as its own release even if the PostHog work slips.
Shipping it first makes the cohort sync a thin plugin on top of a proven engine primitive,
which is the posture that keeps PostHog non-load-bearing.

**02 and 03 ship together.** Splitting them is a documentation convenience, not a shipping
boundary. Cohort sync without the loop guard is a slow oscillator waiting to happen.

**05 has zero runtime coupling to the cohort chain** and can jump the queue if an early
visible win is wanted — but the "zero dependencies" reading was too strong: its paged
definitions fetch needs the rate-limited PostHog client, so it depends on **P0**, not on
PRD 02's cohort client. P0 is small and standalone, so the queue-jump still holds. It
exercises the OAuth credential path end-to-end, which makes it a useful integration smoke
test for everything after it.

**The `import_jobs` cursor column is a shared prerequisite of 02 and 06.** `import_jobs`
has no cursor or metadata column today (`packages/db/src/schema/import-jobs.ts:12-26`), so
both PRDs' resume ACs are unsatisfiable without one. PRD 02 T02.0 owns it. If 06 is likely
to land before 02, hoist it into PRD 00 T00.1's migration instead (that task carries the
note) — but add it exactly once.

**T06.0 is a cross-package edit with two copies.** Stamping `posthog:<uuid>` on the
real-time webhook source must land in BOTH `apps/api/src/webhook-sources/posthog.ts` and
`packages/create-hogsend/template/src/webhook-sources/posthog.ts`. Fixing only the dogfood
consumer ships a scaffold whose backfill silently double-sends.

**09 and 10 are deferred, not cut.** 09 was deferred behind 07 because writeback alone
delivers most of its value with none of the export/import cycle risk. 10 is a public
commitment to stability for a feature whose worst failure mode is slow and hard to detect;
dogfood first.

## Cut from scope

Recorded in `DECISIONS.md` §3: cohort *definition* translation, PostHog flags as journey
conditions, virtual-clock backfill, sub-5-minute cohort latency.
