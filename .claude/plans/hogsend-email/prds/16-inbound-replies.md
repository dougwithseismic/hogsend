# PRD 16 — Inbound replies

**Status:** `[ ]` · **Depends:** 06, 15 · **Boundary:** `apps/cloud`, `packages/engine`

## Goal

When someone replies to an email a journey sent, that reply reaches the customer and becomes an event
a journey can wait on. Today it goes nowhere: **there is no inbound receiving anywhere in the
codebase.**

This is the feature that turns lifecycle email from broadcast into conversation, and it is the one
thing an ESP-shaped product is expected to have that we do not.

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
- **Forwarding is opt-in and separate from the event.** Some customers want the reply in a human
  inbox; some want it only as an event. Both, neither, or either.
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
- WHEN forwarding is enabled, the system SHALL forward to the configured address, and a forwarding
  failure SHALL NOT lose the stored message or the event.
- WHEN inbound is disabled for a domain, the system SHALL stop emitting events and SHALL report the
  MX record as no longer required.

## Tasks

1. **Confirm from AWS's docs**: inbound region availability for `us-east-1`/`eu-west-1`, the SNS
   payload size limit, and whether the S3 action is required for full-size messages. Record citations.
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
6. **Optional forwarding.**
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
