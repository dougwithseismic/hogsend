# PRD 03 — Lean the SES diagnostics on AWS-native tooling (PLAN ONLY — no code this run)

> **Status: design/scoping only.** Answers the question "is a bespoke script the best way, or does
> AWS give us something?" Deliverable is this doc. Depends on PRD 01 (relocation) landing first.

## Goal

Shrink the two diagnostic scripts by leaning on AWS-native primitives, WITHOUT losing the genuine
gap they cover (a hand-written fake can lie; real SES behavior must be checked against a live account).

## Finding: the scripts are the right category but over-built and under-leveraged

### `ses-delivery-proof` — use the SES mailbox simulator

AWS provides fixed simulator addresses that fake an outcome with **no quota use and no reputation
impact**:

| Address | Effect |
|---|---|
| `success@simulator.amazonses.com` | delivered |
| `bounce@simulator.amazonses.com` | hard bounce (SMTP 550) |
| `complaint@simulator.amazonses.com` | spam complaint |
| `ooto@simulator.amazonses.com` | auto-reply / out-of-office |
| `suppressionlist@simulator.amazonses.com` | suppression-list hit |

**Action (future build):** wherever `ses-delivery-proof` synthesizes bounce/complaint events by hand
or risks sending to real inboxes, send to the simulator instead. The IRREDUCIBLE core stays — proving
that *our* pipeline (SES → SNS/EventBridge → `/api/email/reputation` + events routes → Postgres)
actually received and stored the event. AWS cannot prove our own infra; the simulator only makes
*causing* the event safe and cheap.

### `ses-walkthrough` — shrink, don't delete; keep the fake

The walkthrough exists only because we maintain `FakeSesClient`. It is a symptom of the fake.

**Action (future build):** reduce the exhaustive 20-verb real-vs-fake comparison to a targeted
contract check over the ~4–5 verbs whose fake behavior a real code path depends on (send-result
shape, bounce/complaint `EmailEvent` shape, suppression). The exhaustive version is ceremony; drift
that bites lives in a handful of verbs.

## Rejected alternative: LocalStack instead of the hand-written fake

Tempting because it would delete BOTH the fake and the walkthrough. **Rejected:**
- It moves the drift risk into exactly the SES-peculiar corners where our bugs live — v1 receipt
  rules (LocalStack SES→S3 receipt-rule support historically incomplete), reputation policy,
  EventBridge reputation events.
- It bolts a Docker service onto every test run.
- Net: trades "my fake might lie" for "LocalStack might not implement / differs," precisely in the
  areas that matter most. Lean-first: no.

## Decisions needed before a build wave

1. Confirm delivery-proof currently hand-synthesizes events (vs already using the simulator) — audit
   before scoping the change.
2. Which walkthrough verbs are load-bearing? (Derive from: which fake behaviors a runtime code path
   asserts on.)
3. Should a trimmed walkthrough run in CI against LocalStack for the send-only verbs, while inbound/
   reputation stay human-run against real AWS? (Possible middle path; evaluate fidelity first.)

## EARS acceptance criteria (for THIS plan-only PRD)

- WHEN reviewed, the doc SHALL state the simulator integration, the walkthrough-shrink target, and
  the explicit LocalStack rejection with rationale.
- WHEN approved, NO diagnostics code changes are attributable to this PRD (plan only).

## Task breakdown

- **T1 — (this run) Author + review this design.** _Boundary:_ `docs/`. _Depends:_ PRD 01.
- **T2..Tn — (future wave)** simulator integration + walkthrough shrink, each its own task with gates.

## Done when

Reviewed and approved; the three decisions surfaced. No code.

## Implementation Notes

_(filled if/when promoted to a build wave)_
