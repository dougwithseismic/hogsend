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

## Task 1 is ANSWERED — the one-record claim survives

Settled 2026-08-11 against the primary source, **not** by reasoning.

**Source:** AWS SESv2 API Reference, `DkimAttributes`
(`https://docs.aws.amazon.com/ses/latest/APIReference-V2/API_DkimAttributes.html`), the `Tokens`
field, verbatim:

> "If you used Easy DKIM to configure DKIM authentication for the domain, then this object contains a
> set of unique strings that you use to create a set of CNAME records… If you configured DKIM
> authentication for the domain by providing your own public-private key pair, then this object
> contains **the selector for the public key**."

The same page's preamble is equally explicit: "If you provided a public key to perform DKIM
authentication, Amazon SES tries to find **a TXT record** that uses the selector that you specified."

**Therefore `Tokens: ["hogsend"]` is our own selector echoed back. It implies NO second DNS record,
and the ONE TXT record claim is intact.** The walkthrough's warning ("this would make it 2") and PRD
07's note ("`dkim.tokens` must be EMPTY") are both wrong and must be corrected — a non-empty
`tokens` is only alarming when `SigningAttributesOrigin` is `AWS_SES`, where it really is CNAME
tokens. Rewrite the assertion to check ORIGIN, not emptiness.

The same page also documents `NOT_STARTED` as a valid `Status` ("The DKIM verification process hasn't
been initiated for the domain"), confirming AWS's answer rather than the Fake's `PENDING`.

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

Shipped 2026-08-11 (`43ce5779`). Cloud suite 1473 → 1480. **The walkthrough now reports 0
divergences against real AWS**, exit 0: "The Fake told the truth for everything this run exercised."

**The finding worth carrying forward: the identity status is not static.** AWS answered
`NOT_STARTED` from `createIdentity` and `PENDING` from `getIdentity` on the very next call — SES
begins the DNS lookup asynchronously as soon as the identity exists. Correcting `createIdentity` to
`NOT_STARTED` alone therefore INTRODUCED a new divergence at `getIdentity`, which is how it was
caught: a second live run, not reasoning. `NOT_STARTED` exists for exactly one call, and every domain
poller reads through `getIdentity`, so the state a poller sees is always `PENDING`. The Fake now
promotes on first read and a test pins it.

**Two of the ten were type-level, not value-level.** `impact` was typed `HIGH | LOW`; AWS returns
`NONE` for a healthy entity. SDK enums are open, so the wire value arrived regardless and only the
TYPE was wrong — nothing would have thrown, the branch would just have been unreachable. Widened as
`SesReputationImpact` rather than polluting `SesRecommendationImpact`, since `listRecommendations`
really does answer only the two.

**Determinism was preserved deliberately.** AWS stamps `lastUpdatedAt`, and 1480 tests read this
Fake, so the timestamp comes off an injectable clock defaulting to a FIXED instant
(`FAKE_SES_CLOCK`), never wall-clock. A test that needs two writes distinguishable passes its own
`now`.

**Still unproven, and this is the honest gap:** `putEventDestination`, `sendEmail` and `sendBatch`
were SKIPPED, not passed. The first needs a real SNS topic; the other two need a verified sender and
(in sandbox) a verified recipient. **The two verbs that actually deliver mail have never run against
AWS.** Everything around them is now proven; the send itself is not.
