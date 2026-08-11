# PRD 14 — Correct the Fake against real AWS

**Status:** `[ ]` · **Depends:** 11 · **Boundary:** `apps/cloud`

## Goal

The walkthrough ran against a real AWS account on 2026-08-11 and found **10 remaining divergences**
between `FakeSesClient` and SES. Each one is a place where 1473 green tests are asserting something
AWS does not do. Close them, so the Fake earns the trust the whole suite places in it.

Three divergences from that run are already fixed (`77af7296`) because they were failures rather than
inaccuracies: `NextSigningKeyLength` with BYODKIM, the `[object Object]` error shadowing, and the
`ses:TagResource` gap. What is left is the Fake being wrong, not the client.

## The divergences, verbatim from the run

`createIdentity` (3):

| field | AWS | Fake |
| --- | --- | --- |
| `dkim.status` | `NOT_STARTED` | `PENDING` |
| `verificationStatus` | `NOT_STARTED` | `PENDING` |
| `dkim.tokens` | `["hogsend"]` | `[]` |

`getIdentity` (1): `dkim.tokens` — AWS `["hogsend"]`, Fake `[]`.

`getReputationEntity` **before** any customer write (2): AWS returns `impact: "NONE"` and
`policyArn: "arn:aws:ses:us-east-1:aws:reputation-policy/none"`; the Fake omits both.

`getReputationEntity` **after** a customer write (4): AWS additionally returns
`customerManagedStatus.cause: "Status manually updated."` and
`customerManagedStatus.lastUpdatedAt`; the Fake omits both, plus `impact` and `policyArn` as above.

## The question that must be answered FIRST, from a primary source

**Does `DkimAttributes.Tokens: ["hogsend"]` on a BYODKIM identity mean the customer must publish a
SECOND DNS record?** The walkthrough raises it explicitly: *"AWS returned 1 Easy-DKIM token(s) for a
BYODKIM identity. PRD 07 claims ONE TXT record; this would make it 2."*

This is the headline competitive claim of the entire product — one record versus Resend's three — so
it is not a question to reason about from first principles. **Read AWS's own API reference for
`DkimAttributes` / `Tokens` and settle it.** The likely answer is that for `SigningAttributesOrigin:
EXTERNAL` AWS simply echoes the selector we supplied, and that no CNAME is implied, but LIKELY IS NOT
GOOD ENOUGH HERE. Whatever the docs say, record the citation.

- If it is an echo: the one-record claim stands, the Fake must return the selector, and PRD 07's note
  ("`dkim.tokens` must be EMPTY") is itself wrong and must be corrected along with the walkthrough's
  assertion.
- If it implies a second record: that is a product-level finding. STOP and report it rather than
  quietly changing the Fake, because it would invalidate the marketing claim, the docs, and PRD 07.

## Locked decisions

- **The Fake moves toward AWS, never the reverse.** AWS's observed behaviour is the specification.
- **Do not weaken the walkthrough's assertions to make them pass.** If an assertion disagrees with
  AWS, the assertion was wrong and its comment must be rewritten to say what AWS actually does.
- **`NOT_STARTED` must become a real state, not an alias.** Check every consumer of
  `verificationStatus` / `dkim.status` in `apps/cloud` and `packages/*` — anything branching on
  `PENDING` needs to handle `NOT_STARTED`, or a freshly created identity silently falls into the
  wrong branch. This is where the real bug hides.
- **`getReputationEntity`'s shape is load-bearing for PRD 08.** It branches on `customerManagedStatus`
  presence. AWS returning `impact` and `policyArn` even before a customer write means the Fake taught
  the abuse-enforcement tests a shape that does not exist.

## Acceptance criteria (EARS)

- WHEN `createIdentity` succeeds against the Fake, the system SHALL report `verificationStatus` and
  `dkim.status` as `NOT_STARTED`, matching AWS for a freshly created identity.
- WHEN a BYODKIM identity is created or read against the Fake, `dkim.tokens` SHALL match what AWS
  returns for the same input, per the primary-source answer above.
- WHEN `getReputationEntity` is called against the Fake, the system SHALL return `impact` and
  `policyArn` in the same cases AWS does, both before and after a customer-managed write.
- WHEN a customer-managed status exists, the Fake SHALL populate `cause` and `lastUpdatedAt`.
- WHEN any code branches on a verification status, it SHALL handle `NOT_STARTED` explicitly rather
  than falling through a `PENDING`-shaped check.
- WHEN the walkthrough is re-run against AWS, it SHALL report **zero** divergences for these verbs.

## Tasks

1. **Settle the `Tokens` question from AWS's documentation** and record the citation in this PRD.
   Everything else waits on the answer.
   _Boundary:_ none (research) · _Depends:_ none
2. **Correct `FakeSesClient`** for identity status and tokens.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1
3. **Correct `FakeSesClient`** for `getReputationEntity` (`impact`, `policyArn`, `cause`,
   `lastUpdatedAt`), both before and after a customer write.
   _Boundary:_ `apps/cloud` · _Depends:_ none
4. **Audit every consumer of verification status** for a `NOT_STARTED` blind spot and fix what is
   found. Report anything that was branching wrongly — that is a real bug, not a Fake bug.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2
5. **Update the tests** that encoded the old shapes, and correct PRD 07's `tokens must be EMPTY` note
   plus the walkthrough's matching assertion if task 1 says they are wrong.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3, 4

## Seams

- **`putEventDestination` is still unproven** — it needs a real SNS topic in the same account and
  region, and the relay's IAM policy grants no `sns:` actions. Enumerate as an external ask.
- **`sendEmail` / `sendBatch` are still unproven** — sandbox requires both sender and recipient to be
  verified identities. We control `hogsend.com` DNS through Cloudflare, so verifying a sending domain
  is achievable; a recipient address needs a human to click AWS's verification link.

## Done when

The walkthrough re-run against real AWS reports zero divergences for these verbs, the `Tokens`
question is answered from a citation rather than an assumption, and gates are green.

## Implementation Notes
