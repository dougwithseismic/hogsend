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

**CLOSED — NO CODE (2026-08-16). The build-wave investigation refuted this PRD's shrink premise.**

Promoting PRD 03 to a build wave required first answering "which walkthrough verbs are load-bearing?"
(plan decision #2). An evidence scan of every `SesClient` call site under `apps/cloud/src` (excluding
`ses/` internals, `__tests__`, and `diagnostics/`) found:

- **18 of the 20 contract verbs have a direct RUNTIME caller** — `ses-tenants`, `ses-domains`,
  `email-enforcement`, `email-trust-tiers`, `ses-availability`, `reputation-sweep`, `email-relay`,
  `email-inbound-forward`. Only `getTenant` (load-bearing *internally* to `AwsSesClient`'s
  idempotency/ARN reads — no external caller) and `listRecommendations` (zero runtime callers) are
  non-runtime. The plan's assumption that ~15 verbs are "ceremony" is FALSE.
- The `ses-walkthrough` exhaustive real-vs-fake compare is therefore NOT over-built: it is the single
  guarantee that `FakeSesClient` — used pervasively across app tests — does not silently drift from
  real SES on ANY verb a runtime path depends on. Its own test (`ses-walkthrough.test.ts:533-536`)
  DELIBERATELY pins all 20 `SES_VERBS` into the run as a completeness invariant.
- The exhaustive comparison has **no per-test-run cost**: it hits real AWS only when a human passes
  `--i-know-this-hits-aws`; the offline unit tests exercise only the walkthrough machinery. There is
  nothing to "shrink for speed."

**Building the shrink would remove drift-detection for 13 runtime-load-bearing verbs — a coverage
regression, against the wave's zero-regression bar.** Cutting even the two genuinely-unused verbs
(`getTenant`, `listRecommendations`) would force rewriting the clean "all 20" completeness invariant
at `:533` into an "all 20 except these" exception list — MORE machinery, not less. Net negative.

**The delivery-proof half was already done.** `ses-delivery-proof` sends ONLY to the SES mailbox
simulator (`guards.ts:33` `SIMULATOR_DOMAIN`, `requireSimulatorRecipient()` throws on any non-simulator
address, re-checked per scenario at `proof.ts:281`) and hand-synthesizes NO events — real
bounce/complaint flow SES → SNS → ingress → `email_events`. There was never any synthesis to replace.

**Outcome:** PRD 03 closes as investigated-and-refuted. The LocalStack rejection (§ above) stands. The
two harnesses are already right-sized for their job after PRD 01 lifted them out of the app gates; the
genuine simplification of the SES/diagnostics area was PRD 01 (relocation), not a walkthrough shrink.
No diagnostics code changed this wave.
