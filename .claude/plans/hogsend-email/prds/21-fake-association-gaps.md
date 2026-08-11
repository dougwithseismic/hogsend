# PRD 21 — The Fake lets you send from a resource the tenant does not own

**Status:** `[ ]` · **Depends:** 11, 14 · **Boundary:** `apps/cloud`

## Goal

Close the three defects the SECOND live walkthrough found, the worst of which is that every send test
in the repo passes without the tenant-resource association that real SES requires.

## The run (2026-08-11, `20260811-172706-cbd704`, `us-east-1`)

PRD 14 corrected ten divergences found by the FIRST live run. This is the first time anything
re-checked them, and the headline is good: **20 of 22 verbs compared with ZERO divergences, and 0
resources left behind.** The corrections hold and teardown works.

PRD 07's one-record DKIM claim also survived contact with AWS again: `origin=EXTERNAL`,
`status=NOT_STARTED`, `tokens=1`, one TXT record emitted, the token echoed as the selector rather than
implying a second record.

Three verbs disagreed, and they share one root.

## Finding 1 — the walkthrough associates the wrong ARN for an EMAIL_ADDRESS identity

```
associateResource:sender-identity  aws=error:not_found
  aws: Identity <hogsend.com> does not exist
  fake: ok
```

The script derives the sender identity's ARN via `domainOfAddress(sendFrom)`, so
`ses-proof@hogsend.com` became `identity/hogsend.com`. That derivation is right for a DOMAIN identity
and wrong for an EMAIL_ADDRESS one: SES holds the address itself as the identity, and the parent
domain may not exist as an identity at all — which is exactly our case.

Not a contract divergence. A bug in the probe, which then poisoned the two verbs after it. Worth
noting how it was confirmed: a separate hand-run probe the same day associated
`identity/ses-proof@hogsend.com` directly and SES accepted it.

## Finding 2 — the Fake associates an identity that DOES NOT EXIST

Behind the wrong ARN sits a real gap. AWS answered `NotFoundException` because the identity was
absent; `FakeSesClient` answered `ok`. **The Fake does not check that the resource being associated
exists.** Any test that associates a typo'd or unprovisioned identity is green, and production 404s.

## Finding 3 — the Fake SENDS without the tenant owning the identity. This is the serious one.

```
sendEmail  aws=error:invalid
  aws: AccessDeniedException 403 — Tenant not associated with resources
       [arn:aws:ses:us-east-1:929600381829:identity/ses-proof@hogsend.com]
  fake: ok, messageId=fake-ses-message-1
```

`sendBatch` diverged the same way across all five compared fields, and correctly so — our per-entry
failure shape was right; the Fake simply had no failure to report.

Real SES refuses a tenant-scoped send unless the sending identity is associated with that tenant. The
Fake does not model that rule at all, so **every send test in this repository passes without it.** If
provisioning ever stopped associating the identity — a regression, a partial failure, a resumed run
that skipped the step — the suite would stay green and every customer send would 403 in production.

That is precisely the shape PRD 14 exists to prevent, in the one verb pair that carries the product.

## Locked decisions

- **The Fake gains the association rule, not a special case for these tests.** `sendEmail`/`sendBatch`
  must refuse with the same `kind` AWS returns when the identity is not associated with the tenant.
  Some existing tests will go red; that is the finding surfacing, not a regression to route around.
- **Fix the walkthrough's ARN derivation by IDENTITY TYPE**, not by pattern-matching an `@`. An
  address is an EMAIL_ADDRESS identity, a bare domain is a DOMAIN identity, and the script should say
  which it is deriving and why.
- **Do NOT weaken the assertion to make tests pass.** Any test that sent without associating was
  asserting something SES will not do.

## Acceptance criteria (EARS)

- WHEN a send names a tenant that does not have the sending identity associated, the Fake SHALL refuse
  with the same error kind AWS returns.
- WHEN a resource is associated that does not exist, the Fake SHALL answer `not_found`.
- WHEN the walkthrough is given an email-address sender, it SHALL associate that address's identity
  ARN and not its parent domain's.
- WHEN the walkthrough runs with a verified sender, the send verbs SHALL be compared rather than
  skipped, and SHALL report zero divergences.

## Tasks

1. **Fix the walkthrough's sender-identity ARN derivation** by identity type.
   _Boundary:_ `apps/cloud` · _Depends:_ none
2. **Teach the Fake the association rule** for `associateResource` (existence) and
   `sendEmail`/`sendBatch` (tenant must own the identity). Expect existing tests to go red.
   _Boundary:_ `apps/cloud` · _Depends:_ none
3. **Repair every test the new rule reddens** by associating properly, never by weakening the rule.
   Report the count — it is the measure of how much was being certified falsely.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2
4. **Re-run the live walkthrough** with a verified sender and confirm the send verbs compare clean.
   _Boundary:_ none · _Depends:_ tasks 1-3

## Seams

- Task 4 needs real AWS and a verified sender. Both exist as of 2026-08-11.

## Done when

The live walkthrough reports zero divergences across all 22 verbs including the send pair, and the
Fake refuses a send the real service would refuse.

## Implementation Notes
