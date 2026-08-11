# PRD 11 — Live SES contract walkthrough

**Status:** `[ ]` · **Depends:** 02, 06, 07 · **Boundary:** `apps/cloud`

## Goal

Prove the Fake tells the truth. Every one of the 433 tests covering this stack runs against
`FakeSesClient` or an injected transport, so a place where the Fake is more permissive than AWS is a
production-only bug with a green test in front of it. PRD 02 shipped 1089 tests green while carrying
a cross-tenant suppression leak for exactly this reason.

This PRD adds ONE script that walks the real provisioning path against a real AWS account and fails
loudly wherever AWS disagrees with what we modelled.

## Locked decisions

- **Not a CI job, and not a vitest file.** It needs real credentials, real DNS and a real inbox, and
  it creates billable stateful AWS resources. A `describe.skipIf` that silently no-ops in CI is worse
  than no test: it reads as coverage and asserts nothing. It is a script, run by a human, on purpose.
- **SES sandbox is enough, and that is the point.** Sandbox restricts WHO you may send to and HOW
  MUCH, not the API surface. Tenants, identity creation, BYODKIM verification, configuration sets and
  SNS event destinations all work in sandbox, so this runs the day the account exists rather than
  after production access is granted. Verify that claim on first run and record the answer.
- **It reuses the existing seam, adds no plumbing.** `apps/cloud/src/ses/index.ts` already switches
  Fake to real purely on `CLOUD_AWS_ACCESS_KEY_ID` + `CLOUD_AWS_SECRET_ACCESS_KEY`. The script sets
  nothing else and constructs no client directly.
- **Every resource it creates is namespaced and torn down.** A run leaves the account as it found it,
  including on failure. Resources carry a run-scoped suffix so a crashed run is identifiable and
  sweepable rather than colliding with the next one.
- **The output is a diff against the Fake, not a pass/fail.** For each verb the script records what
  AWS actually returned and compares it to what `FakeSesClient` returns for the same input. A
  disagreement is the deliverable. Print all of them; do not stop at the first.
- **It never runs against a tenant-bearing production account by accident.** Require an explicit
  `--i-know-this-hits-aws` flag AND refuse to run when the resolved account already holds tenants the
  script did not create.

## Acceptance criteria (EARS)

- WHEN the script is invoked without both AWS credential vars, the system SHALL exit non-zero with a
  message naming the two vars, and SHALL NOT construct an AWS client.
- WHEN the script is invoked without the explicit confirmation flag, the system SHALL exit non-zero
  and SHALL make no AWS call.
- WHEN the script runs, the system SHALL exercise the tenant lifecycle (`createTenant`, `getTenant`,
  the suppression-scope write, resource association, configuration set, event destination) and SHALL
  record AWS's response for each.
- WHEN the script runs, the system SHALL create an email identity with the 2048-bit BYODKIM signing
  attributes PRD 07 generates, and SHALL report the exact DKIM record AWS expects so it can be
  compared against the ONE TXT record PRD 07 claims.
- WHEN AWS's response for a verb differs from `FakeSesClient`'s response for the same input, the
  system SHALL report the divergence with the verb, the input, both answers, and SHALL continue to
  the remaining verbs.
- WHEN any step fails, the system SHALL still attempt teardown of everything it created, and SHALL
  report what it could not remove.
- WHEN the run completes, the system SHALL exit non-zero if any divergence was found, so it is usable
  as a gate once the account is stable.

## Tasks

1. **The runner skeleton** — argument parsing, the two credential guards, the confirmation flag, the
   account-not-empty refusal, run-scoped naming, and teardown-on-failure via a registered cleanup
   stack. No AWS verbs yet; test the guards first.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **The divergence recorder** — run a verb against both the real client and a `FakeSesClient` seeded
   to the same state, structurally compare, collect rather than throw.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1

3. **The walkthrough itself** — tenant lifecycle, identity + BYODKIM, configuration set, event
   destination, one send, teardown. Ordered so each step's output feeds the next.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2

4. **Tests for the parts that are testable without AWS** — the guards, the naming, the divergence
   recorder's comparison logic (feed it two known-different answers, assert it reports), and the
   cleanup stack running in reverse on a thrown error. Mutation-check the credential guard.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2, 3

## Seams

- The run itself needs the AWS account (PRD 01). The script is the deliverable here; the FINDINGS are
  owed back into the Fake once it has been run once, and that correction is a follow-up PRD.

## Done when

The script exists, refuses to run without explicit credentials and confirmation, its guards and
comparison logic are tested and mutation-checked, and gates are green.

## Implementation Notes
