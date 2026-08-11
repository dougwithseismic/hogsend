# PRD 16 — Inbound replies

**Status:** `[ ]` · **Depends:** 06, 15 · **Boundary:** `apps/cloud`, `packages/engine`

## Goal

When someone replies to an email a journey sent, that reply reaches the customer and becomes an event
a journey can wait on. Today it goes nowhere: **there is no inbound receiving anywhere in the
codebase.**

This is the feature that turns lifecycle email from broadcast into conversation, and it is the one
thing an ESP-shaped product is expected to have that we do not.

## Reply-To is the DEFAULT, and it already works — read this before building anything

Doug asked the right question: *"do we even need to know about replies? Shouldn't it go to their
email inbox?"* For most customers, yes, and it already does.

`replyTo` is plumbed end to end TODAY — engine mailer → `SendEmailOptions` → plugin-hogsend → relay →
SES `ReplyToAddresses`. A customer sets `Reply-To: support@theircompany.com` and the reply lands in
their Google Workspace like any other mail. **No inbound infrastructure, no MX change, no DNS, no
build.** That is the right default and it must stay the right default.

**So this PRD is NOT "how do customers receive replies".** It is one narrower thing:

> **so a JOURNEY can know a human replied, and stop.**

Without it a contact replies "please stop emailing me" and the sequence sends three more. That is the
single most-requested lifecycle behaviour and it is the only thing `Reply-To` cannot deliver.

Consequences that follow directly, and that a builder must not lose:

- **Inbound is OPT-IN per domain, never automatic.** A customer who just wants replies in their inbox
  sets `Reply-To` and touches no DNS.
- **When inbound IS on, forwarding is MANDATORY, not an option.** A person replying to a human
  expects a human to read it. If we intercept a reply and only emit an event, we have broken their
  business to gain a feature. Forward first, emit second; a forwarding failure is an incident, not a
  warning.
- **The event is the product; the mailbox is not.** We are not building an inbox, a threading UI, or
  a helpdesk. Store the raw message, emit `email.replied`, forward to the human. Stop there.

## The safety rule that shapes the whole design

**Never point MX at SES for a customer's root domain.** Their root MX is their real mailbox — Google
Workspace, Microsoft 365, whatever their company runs on. Repointing it does not add replies, it
DELETES their company email. Every part of this feature must make that mistake impossible rather than
merely discouraged:

- Replies are received on a **dedicated subdomain** (`reply.<domain>` by default, configurable per
  PRD 15's label rules), never the apex.
- The system SHALL refuse to emit an inbound MX record for a domain that already has an MX it did not
  create, unless the operator explicitly overrides with a typed confirmation.
- The setup flow states plainly what the record does before it is published.

## Locked decisions

- **SES inbound receiving is the mechanism.** MX → `inbound-smtp.<region>.amazonaws.com`, a receipt
  rule set, and an action. **Inbound is NOT available in every SES region — confirm `us-east-1` and
  `eu-west-1` support it from AWS's own docs before building**, and if a region lacks it, say so
  rather than designing around an assumption. That is the same discipline that caught the BYODKIM
  failure.
- **The action is SNS → control plane**, mirroring PRD 05's status pipeline, so there is one inbound
  path rather than two. **SNS has a message size limit; a real email with attachments will exceed
  it.** Design for S3 + SNS notification (store the raw MIME in S3, notify with the key) rather than
  discovering the limit in production. Confirm the actual limits before choosing.
- **The reply is normalized to an EVENT, not just forwarded.** `email.replied` on the outbound spine,
  carrying the in-reply-to message id so it can be correlated to the original `email_sends` row and
  therefore to the journey and contact. A reply that cannot be correlated is still delivered, but is
  reported as uncorrelated rather than dropped.
- **Journeys can wait on it.** `ctx.waitForEvent({ event: "email.replied" })` should work with no new
  primitive — verify that claim rather than assuming it.
- **Forwarding is MANDATORY whenever inbound is on** (this supersedes an earlier draft of this line
  that called it opt-in — the two contradicted each other and this is the correct one). A person
  replying to a human expects a human to read it, so intercepting a reply and emitting only an event
  breaks their business to gain a feature. Forward first, emit second. A forwarding failure is an
  incident, not a warning. The destination is configurable; whether to forward at all is not.
- **Spam and loop protection is mandatory, not a follow-on.** An auto-responder replying to our
  address can loop. Honour `Auto-Submitted` / `Precedence: bulk` headers and never emit an event for
  a message that carries them.
- **Attachment handling is a security surface.** Raw MIME from strangers. Do not parse eagerly into
  anything that executes; store, reference, and let the customer opt in to retrieval.

## Acceptance criteria (EARS)

- WHEN a domain enables replies, the system SHALL emit an MX record for `reply.<domain>` pointing at
  the region's SES inbound host, and SHALL NOT emit any record for the apex.
- WHEN the target domain already has an MX record the system did not create, the system SHALL refuse
  to proceed without an explicit typed confirmation.
- WHEN SES receives a message for a configured domain, the system SHALL store the raw MIME durably
  and SHALL emit `email.replied` with the in-reply-to id, the sender, and a text body.
- WHEN a received message carries `Auto-Submitted` or `Precedence: bulk`, the system SHALL store it
  and SHALL NOT emit an event.
- WHEN a reply cannot be correlated to an `email_sends` row, the system SHALL still store and deliver
  it, and SHALL mark it uncorrelated.
- WHEN inbound is enabled for a domain, the system SHALL forward every received message to the
  configured human address, and a forwarding failure SHALL NOT lose the stored message or the event.
- WHEN inbound is enabled without a forwarding address configured, the system SHALL refuse to enable
  it, because that configuration silently swallows a customer's replies.
- WHEN inbound is disabled for a domain, the system SHALL stop emitting events and SHALL report the
  MX record as no longer required.

## Task 1 findings (2026-08-11) — the premise HOLDS

Unlike PRD 17, where the same discipline refuted the plan, here the docs confirm it. Recording that
explicitly: the check is worth running whether or not it finds something, and "confirmed, with
citations" is a different state from "assumed".

**Region availability — both our regions support inbound.** From the *Email Receiving endpoints* table
(`general/latest/gr/ses.html#ses_inbound_endpoints`):

| Region | Inbound endpoint |
| --- | --- |
| `us-east-1` | `inbound-smtp.us-east-1.amazonaws.com` |
| `eu-west-1` | `inbound-smtp.eu-west-1.amazonaws.com` |

22 regions in total. The only exclusions are **AWS GovCloud (US-West) and (US-East)**, stated verbatim:
*"Amazon SES does not support email receiving in the following Regions"*. Notably `eu-central-2`,
`ap-south-2`, `ap-southeast-5`, `ca-west-1` and `me-central-1` are ALSO absent from the inbound table
while present in the sending table — so inbound availability is a strict subset of sending
availability, and the seam must treat it as its own lookup rather than assuming any sending region can
receive.

**S3 is REQUIRED, not an optimisation.** From *Service quotas in Amazon SES*, Email receiving quotas:

> Maximum email size (including headers) that can be published using an Amazon SNS notification:
> **150 KB**. Adjustable: **No**.

> Maximum email size (including headers) that can be stored in an Amazon S3 bucket: **40 MB**.

> Maximum email headers size that can be published using an Amazon SNS notification: 10 KB.

150 KB is smaller than an ordinary reply carrying a phone photo, so an SNS-only design would fail on
real mail and succeed on every test fixture. **S3 action + SNS notification carrying the object key**
is the only design that survives contact with a real inbox.

**Receipt rules are current.** No deprecation or "new customers should" language anywhere in
*Email receiving with Amazon SES*; receipt rules and IP address filters are still presented as the two
mechanisms. Mail Manager exists alongside (its own quotas, its own SMTP relay IP ranges) and is NOT a
replacement we are being pushed toward. Build on receipt rules.

**Regional constraint on the resources themselves**, from *Regions and Amazon SES*:

> "With the exception of Amazon S3 buckets, all of the AWS resources that you use for receiving email
> with SES have to be in the same AWS Region as the SES endpoint."

So the SNS topic and any Lambda are region-pinned to the tenant's SES region; the S3 bucket is the one
resource that may be shared across regions.

## Task 1, part two (2026-08-11) — receipt rules are SES **v1**. The seam cannot carry them.

Task 1 confirmed regions and the S3 requirement but never asked WHICH API the verbs live in. They do
not live in ours.

**The SESv2 operations list contains no receipt-rule operation of any kind.** No `CreateReceiptRule`,
no `CreateReceiptRuleSet`, no `SetActiveReceiptRuleSet`, no `DescribeReceiptRule`. The full v2 action
list runs from `BatchGetMetricData` to `UpdateReputationEntityPolicy` and email RECEIVING is absent
from it entirely. Every receipt-rule verb is SES **v1** (`@aws-sdk/client-ses`), a different client
from the `@aws-sdk/client-sesv2` this stack is built on.

Three consequences that reshape the tasks below:

- **A second AWS SDK dependency.** `@aws-sdk/client-ses` has to be added; nothing in `apps/cloud`
  imports it today (the installed AWS packages are `client-sesv2`, `client-s3` and
  `s3-request-presigner`).
- **The nineteen-verb `SesClient` contract must NOT absorb these.** It is the frozen v2 surface that
  PRD 02 declared, PRD 11 walked and PRD 21 proved clean against AWS. Bolting a second API's verbs
  onto it would mean one contract standing for two services with different clients, different error
  shapes and different regional availability. Inbound gets its OWN seam — `SesInboundClient`, its own
  Fake — sharing only the credentials and the region mapping.
- **The walkthrough cannot cover it.** `ses-walkthrough` compares the v2 contract; inbound needs its
  own comparison if it is ever to be trusted, and until one exists its Fake is unproven in exactly the
  way PRD 14 found the v2 Fake to be.

This is the fifth time in this wave that reading the primary source before building changed the plan,
and the second time it deleted an assumption the PRD had already written down as settled.

## Tasks

1. ~~**Confirm from AWS's docs**: inbound region availability, the SNS payload size limit, and whether
   the S3 action is required.~~ **DONE — see the findings above. The premise holds; S3 is mandatory.**
   _Boundary:_ none · _Depends:_ none
2. **Extend the SES seam** with the receipt-rule verbs. Contract + `aws.ts` + Fake together, and the
   Fake must model AWS's real answers — see PRD 14 for what happens when it does not.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1
3. **Provision inbound per domain**: rule set, rule, S3/SNS action, MX record emission with the
   existing-MX guard.
   _Boundary:_ `apps/cloud` · _Depends:_ task 2
4. **Receive endpoint**: verify SNS signature (reuse PRD 05's verifier — do not write a second one),
   fetch from S3, parse MIME, correlate, emit.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3
5. **`email.replied` on the outbound spine** + the engine-side ingest so journeys can wait on it.
   _Boundary:_ `packages/engine` · _Depends:_ task 4
6. **Forwarding to the human address** (mandatory whenever inbound is on).
   _Boundary:_ `apps/cloud` · _Depends:_ task 4
7. **Tests**, including the apex-MX refusal, the auto-responder loop guard, and an uncorrelated reply.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2-6

## Seams

- The relay IAM policy needs `ses:*ReceiptRule*` and S3/SNS permissions. It currently has neither, and
  the policy in `docs/ses-production-access-request.md` must be updated in the same change.
- A real inbound test needs the MX published on a domain we control. `hogsend.com` is on Cloudflare
  and reachable through the API, so this is self-serviceable for dogfooding.

## Done when

A reply to a Hogsend-sent email lands as `email.replied`, a journey can wait on it, the apex MX guard
is tested, and gates are green.

## Implementation Notes
