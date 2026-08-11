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

Shipped 2026-08-11 (`70b51ff8`). Cloud suite 1425 → 1473 (87 files). Run it with
`pnpm --filter @hogsend/cloud ses:walkthrough --i-know-this-hits-aws`.

**It has not been run against AWS yet, and that is the point of it.** Until it has, the divergence
count is unknown, not zero. Nothing in this PRD's green gates says the Fake is right.

**The one seam it hit, and how it was handled.** The account-not-empty guard needs to ENUMERATE
tenants, and `listTenants` is not one of the nineteen verbs — nothing in the control plane enumerates,
because production addresses exactly one tenant per environment by a name it derives. Adding a
twentieth verb is a PRD 02 decision, so the author did not touch the settled seam. It isolated one
read-only `ListTenants` call in `census.ts`, on the same credentials, with the reasoning written in.
The alternative it explicitly refused is the one worth naming: making the guard an operator assertion
on the command line, which reads as a safety check and checks nothing, protecting against
"the destructive walkthrough ran against the account holding live customers".

**Owed to PRD 02: promote `listTenants` to verb #20** and delete `census.ts`.

**Three independent refusals, all before any client is constructed.** That ordering is load-bearing:
`getSesClient` answers absent credentials with `FakeSesClient`, which is right for the control plane
and useless here, since a walkthrough silently comparing the Fake against the Fake would report zero
divergences and prove nothing. A leftover tenant from a previous crashed run is deliberately NOT a
refusal, only a report — refusing on it would let one crash permanently block the script, which is
how guards end up disabled.

**Verified by running it, not only by its tests.** Both refusals produce their message and exit 1.
Mutation-checked: weakening the credential guard to accept a half-set pair turns 3 tests red;
disabling the account-not-empty guard turns 2 red.

**A caching trap worth recording.** `turbo run check-types --filter=@hogsend/cloud` reported
`FULL TURBO` (fully cached) with all of this PRD's files present, because they were still UNTRACKED
and turbo hashes git-tracked inputs. A cached PASS over code the compiler never saw is a vacuous
green. Re-run with `--force` when reviewing untracked work; both gates pass genuinely.
