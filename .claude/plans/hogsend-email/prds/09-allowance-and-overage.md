# PRD 09 — Allowance and metered overage

**Status:** `[ ]` · **Depends:** 03, 06 · **Boundary:** `apps/cloud`

## Goal

Count every send, enforce the plan allowance, and bill overage through the billing contract that
already exists. Locked with the user 2026-08-10: **included allowance plus metered overage.**

The meter already has a sink. `usage_counters` carries `emailsCount` and upserts on
`(environment_id, month)`. This PRD supplies the source, the enforcement, and the Stripe leg.

## Locked decisions

- **Count at the relay, after the send succeeds.** Counting before the send bills for failures;
  counting in the engine means a self-hosted instance could under-report. The relay is the only
  place that sees every Hogsend Email send and knows it worked.
- **Increment by upsert**, using the existing `onConflictDoUpdate` idiom against the
  `(environment_id, month)` unique index. Concurrent sends must never lose a count and must never
  need a read-first round trip.
- **An idempotent re-send does not double-count.** PRD 03 short-circuits on the idempotency key
  before reaching SES, so it must also skip the increment. A journey replay must not bill twice.
- **The allowance is a hard cap, and the cap is an abuse control before it is a billing control.**
  Even with overage billing enabled, there is a ceiling beyond which sending stops rather than
  billing unboundedly. A compromised tenant key that bills $40,000 of overage is not a success case.
- **Overage reports as Stripe usage records through `apps/cloud/src/billing/`**, which already has a
  `types.ts` / `stripe.ts` / `fake.ts` split. Every test runs against the Fake.
- **Reporting is reconciled, not fire-and-forget.** A periodic job compares reported usage against
  the counter and repairs drift, because a dropped usage record is silent lost revenue and a
  duplicated one is a customer complaint.
- **Warn before blocking.** Notify at a threshold below the cap so hitting it is never a surprise.

## Acceptance criteria (EARS)

- WHEN a send succeeds at the relay, the system SHALL increment `usage_counters.emailsCount` for that
  environment and the current UTC month by exactly one, by upsert.
- WHEN a batch send succeeds, the system SHALL increment by the number of successfully sent items,
  not by the number submitted.
- WHEN a send is short-circuited by the idempotency key, the system SHALL NOT increment.
- WHEN a send fails, the system SHALL NOT increment.
- WHEN an environment's month-to-date count is below its plan allowance, `canSend` SHALL return
  allowed.
- WHEN the count is above the allowance and overage is enabled for the plan, `canSend` SHALL return
  allowed and the send SHALL be recorded as overage.
- WHEN the count reaches the hard cap, `canSend` SHALL return denied with reason
  `allowance_exhausted`, and the relay SHALL return `403` without calling SES.
- WHEN month-to-date usage crosses the warning threshold, the system SHALL notify the environment
  owner exactly once per month per threshold.
- WHEN the reporting job runs, the system SHALL report overage to the billing contract for each
  environment with overage, and SHALL be safe to run twice without double-reporting.
- WHEN reconciliation finds reported usage diverging from the counter, the system SHALL repair the
  difference and record that it did.

## Tasks

1. **Implement `canSend(environmentId)`**, the interface PRD 03 stubbed. Reads the counter, the plan
   allowance, the tier cap from PRD 08, and returns allowed/denied with a reason. Pure decision
   function over injected inputs so the rules are testable without a database.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **Metering increment at the relay**, upsert-based, correct for single and batch, skipped on
   idempotent replay and on failure.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **Plan allowance configuration** — where a plan's included sends, hard cap and overage-enabled
   flag live, alongside the existing billing plan config.
   _Boundary:_ `apps/cloud` · _Depends:_ none

4. **Warning notifications**, once per threshold per month, idempotent.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 3

5. **Overage reporting job** over the billing contract, safe to re-run.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3

6. **Reconciliation job** comparing reported against counted, repairing and recording drift.
   _Boundary:_ `apps/cloud` · _Depends:_ task 5

7. **Tests.** Every EARS line, against the billing Fake and the SES Fake. Specifically: concurrent
   increments do not lose counts (drive real concurrent upserts, do not assume); an idempotent replay
   increments zero times; running the reporting job twice reports once. Mutation-check the hard cap.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2, 4, 5, 6

## Seams

- The actual allowance and cap numbers per plan are the user's commercial call. Implement them as
  named constants in one place and surface the proposed numbers for sign-off.

## Done when

Counting is correct under concurrency and replay, the hard cap blocks at the relay, overage reports
idempotently through the billing Fake, reconciliation repairs injected drift, and gates are green.

## Implementation Notes
</content>
