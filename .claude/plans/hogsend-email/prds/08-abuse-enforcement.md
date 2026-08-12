# PRD 08 — Abuse enforcement

**Status:** `[ ]` · **Depends:** 02, 03, 06 · **Boundary:** `apps/cloud`, `packages/studio`

## Goal

Know within seconds when a tenant goes bad, stop them without touching anyone else, tell them why,
and give them a way back. This is the PRD that protects the aggregate account reputation, and per
DECISIONS §2 the aggregate is still ours to protect even with per-tenant isolation.

## Locked decisions

- **SES does the detection; we do the reaction.** Reputation policies already pause a tenant
  automatically. We are not rebuilding bounce-rate math. We consume the EventBridge signal, mirror
  the state into our DB so PRD 03 can fail closed without an AWS round trip, notify the customer, and
  surface it.
- **Two EventBridge detail-types:** `Sending Status Disabled` / `Sending Status Enabled` for status,
  and `Advisor Recommendation Status Open` / `Closed` for findings. Findings are a warning surface;
  status is the enforcement surface. Both are recorded, only status gates sending.
- **Trust tiers drive the reputation policy**, not a hand-set field:

  | Tier | Entry | Reputation policy | Send cap | Bulk import |
  | --- | --- | --- | --- | --- |
  | `new` | at provision | `None` (observed) | low daily cap | blocked |
  | `established` | clean sending over a defined volume and window | `Standard` | plan allowance | allowed |
  | `watched` | after a resolved finding | `Strict` | reduced | blocked |

  Promotion is automatic on the volume-and-window criteria; demotion to `watched` is automatic on a
  finding. Promotion out of `watched` is manual.

- **The numbers behind that table, proposed 2026-08-10 while drafting the AUP.** They are recorded
  here rather than "during build" because `docs/acceptable-use-policy.md` §5 already publishes them
  to customers, and a policy that promises one number while the code enforces another is worse than
  having no number. **These are PENDING Doug's sign-off**, but they are what the build implements
  until he says otherwise, and PRD 08 is the ONE place they may be defined.

  | Constant | Value | Reasoning |
  | --- | --- | --- |
  | `SUSPEND_BOUNCE_RATE` | `0.05` | The rate at which AWS puts an entire ACCOUNT under review. Suspending here is the last point at which one tenant is still our problem rather than AWS's. |
  | `SUSPEND_COMPLAINT_RATE` | `0.001` | Same reasoning, AWS's account-review complaint threshold. |
  | `NEW_TIER_DAILY_CAP` | `500` | The real bound on a `new` tenant's damage, since its reputation policy is `None`. Low enough that a bad first list cannot produce meaningful bounce volume. |
  | `ESTABLISHED_MIN_DAYS` | `14` | Consecutive days of sending. |
  | `ESTABLISHED_MIN_DELIVERED` | `1000` | A record, not a trickle. Both this AND the day count must hold. |
  | `ESTABLISHED_MAX_BOUNCE_RATE` | `0.02` | Deliberately stricter than the suspend threshold: promotion should require being comfortably clean, not merely not-yet-suspended. |
  | `ESTABLISHED_MAX_COMPLAINT_RATE` | `0.0005` | Same. |
  | `WATCHED_CAP_FRACTION` | `0.25` | Of the plan allowance. |

  Implement them as named exports in one module. A magic `0.05` inline is how the AUP and the code
  drift apart six months from now.
- **`None` for new tenants is observation, not permissiveness.** The send cap is what actually bounds
  a new tenant's damage. AWS's own guidance is to observe before enforcing, and a brand-new tenant
  auto-paused by a single hard bounce on 10 emails is a terrible first experience.
- **No bulk list import on the shared pool below `established`.** DECISIONS §8. This is the single
  highest-value abuse control in the stack, because the scraped-list blast is the specific event that
  damages aggregate reputation fastest.
- **Suspension notice is factual and cites a clause.** PRD 01 owns the copy. This PRD sends it.
- **Appeals are a human queue, not an automated unpause.** An automatic reinstate on request is an
  automatic bypass. Note that SES's `reinstated` state ignores active findings during recovery, so an
  unpause without a resolved root cause simply re-pauses later.

## Acceptance criteria (EARS)

- WHEN an EventBridge `Sending Status Disabled` event arrives for a known tenant, the system SHALL
  set that environment's sending status to paused with the event's cause and timestamp, within one
  processing cycle, and SHALL NOT affect any other environment.
- WHEN an `Advisor Recommendation Status Open` event arrives, the system SHALL record the finding
  with its type, impact and description, and SHALL demote the tenant to the `watched` tier.
- WHEN a tenant is paused, the system SHALL send the suspension notice to the environment's owner,
  exactly once per pause event.
- WHEN a paused tenant attempts to send, the system SHALL fail closed per PRD 03 and the failure
  reason SHALL be the recorded cause, not a generic error.
- WHEN a tenant meets the `established` criteria, the system SHALL set its SES reputation policy to
  `Standard` and raise its cap to the plan allowance.
- WHEN a tenant is demoted to `watched`, the system SHALL set its SES reputation policy to `Strict`
  and block bulk import.
- WHEN a tenant below `established` attempts a bulk list import, the system SHALL refuse it with an
  explicit reason naming the tier requirement.
- WHEN an operator views a tenant in Studio, the system SHALL show sending status, tier, current cap,
  open findings, and pause history.
- WHEN an EventBridge event arrives for an unknown tenant, the system SHALL record it and SHALL NOT
  throw, so one stale tenant cannot wedge the event pipeline.

## Tasks

1. **EventBridge ingress endpoint** with signature/source verification, handling all four
   detail-types. Same security posture as PRD 05's SNS endpoint; reuse rather than reimplement where
   the shapes allow.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **Schema:** findings table, pause-history table, and the tier column on the environment. The
   sending-status table already exists from PRD 03 task 3; write to it here.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **Status and finding handlers** — mirror state, record history, demote on finding.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2

4. **Trust-tier engine** — the promotion/demotion rules, and the SES reputation-policy call that
   follows each transition. Pure decision function plus an effectful applier, so the rules are
   testable without AWS.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3

5. **Send caps** wired into PRD 03's pre-send path, keyed on tier.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

6. **Bulk-import block** below `established`, with an explicit refusal reason.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

7. **Suspension notice** — one send per pause event, using PRD 01's copy. Idempotent on the pause
   event id so a redelivered EventBridge event does not re-notify.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3

8. **Studio surface** — status, tier, cap, open findings, pause history on the tenant view.
   Observe-only; no unpause button, because appeals are a human queue.
   _Boundary:_ `packages/studio` · _Depends:_ tasks 2, 3, 4

9. **Tests.** Every EARS line. Drive real transitions through the Fake. Specifically prove that
   pausing tenant A leaves tenant B sending, since that isolation claim is the entire justification
   for the architecture and a test that never checks it would certify nothing. Mutation-check the
   fail-closed path and the bulk-import block.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 3, 4, 5, 6, 7

## Seams

- The exact `established` thresholds (volume, window, complaint ceiling) are a product judgment.
  **Proposed and recorded in Locked decisions above** on 2026-08-10; still pending Doug's sign-off.
  They are already published to customers in `docs/acceptable-use-policy.md` §5, so a change has to
  move both files in one commit.
- Real EventBridge event shapes should be confirmed against a live account once PRD 01 lands.

## Done when

All four detail-types are handled, tier transitions drive real SES policy calls against the Fake,
cross-tenant isolation is proved by test, the Studio surface renders, and gates are green.

## Implementation Notes
</content>
