# PRD 05 — Email event ingress

**Status:** `[ ]` · **Depends:** 02, 04 · **Boundary:** `apps/cloud`, `packages/plugin-hogsend`

## Goal

Get delivery, bounce, complaint and delay signals from SES back into the tenant's engine, where
`emailService.handleWebhook` already knows what to do with them. Two hops: SES → control plane, then
control plane → tenant instance.

Without this, suppression never happens, `email_sends` never reaches a terminal status, and bounce
handling silently does nothing.

## Locked decisions

- **SES → SNS → control plane.** The configuration set's event destination publishes to an SNS topic
  per region; the control plane exposes an SNS subscription endpoint. EventBridge is used in PRD 08
  for tenant STATUS events, which are a different stream with a different shape. Do not conflate
  them.
- **Only `delivered`, `bounced`, `complained` and `delivery_delayed` are consumed.** Opens and clicks
  are first-party and sovereign; SES native tracking stays off. Subscribing to SES open/click events
  would create duplicate, worse-quality signal.
- **SNS signature verification is mandatory** and must validate the certificate URL against the AWS
  SNS domain before fetching it. An unvalidated `SigningCertURL` is a straightforward SSRF and a
  forged-event vector. Subscription confirmation is handled explicitly, not by blindly GETting
  whatever URL arrives.
- **The control plane routes by SES tenant name → environment**, then delivers to that environment's
  instance webhook URL. The tenant name is in the event's configuration-set/tag metadata; if it
  cannot be resolved, the event is recorded and dropped rather than broadcast.
- **The control-plane → instance hop is HMAC-signed** with the environment's webhook secret, which is
  the secret `plugin-hogsend.verifyWebhook` checks. Include a timestamp in the signed payload and
  reject stale ones, so a captured delivery cannot be replayed indefinitely.
- **Delivery is at-least-once, so the shape must be idempotent.** Each normalized event carries a
  stable dedupe key. The engine's existing webhook handling is the consumer; do not add a second
  dedupe layer if the existing one already covers it, and confirm which is true during build rather
  than assuming.

## Acceptance criteria (EARS)

- WHEN an SNS message arrives with an invalid signature, or a `SigningCertURL` outside the AWS SNS
  domain, the system SHALL reject it with `403`, SHALL NOT fetch the certificate, and SHALL NOT
  deliver anything downstream.
- WHEN an SNS subscription-confirmation message arrives for a topic we own, the system SHALL confirm
  it explicitly; for any other topic the system SHALL reject it.
- WHEN a valid SES `Bounce` notification arrives, the system SHALL normalize it to
  `type: "email.bounced"` with the bounce classified `permanent` for `Permanent` and `transient` for
  `Transient`, defaulting to `unknown` for anything else.
- WHEN a valid SES `Complaint` notification arrives, the system SHALL normalize it to
  `type: "email.complained"`.
- WHEN a valid SES `Delivery` notification arrives, the system SHALL normalize it to
  `type: "email.delivered"`.
- WHEN an event's SES tenant cannot be resolved to a known environment, the system SHALL record the
  event with the unresolved tenant name and SHALL NOT deliver it to any instance.
- WHEN the control plane delivers to an instance, the system SHALL sign the payload with that
  environment's webhook secret and include a timestamp, and the instance SHALL reject a payload
  older than the configured skew.
- WHEN an instance webhook delivery fails, the system SHALL retry with bounded backoff and SHALL
  record a terminal failure after exhaustion rather than retrying forever.

## Tasks

1. **SNS topic and event-destination wiring.** Implement `putEventDestination` (already declared on
   PRD 02's contract) in the AWS client and the Fake, and attach the per-region SNS topic to each
   tenant's configuration set.
   _Boundary:_ `apps/cloud` · _Depends:_ none

2. **SNS signature verification.** Certificate-URL allowlist, signature check, explicit subscription
   confirmation. This is security-critical: table-test the rejection cases first, including a
   look-alike host and a URL with an embedded `@`.
   _Boundary:_ `apps/cloud` · _Depends:_ none

3. **`POST /api/email/events/[region]`** — the SNS endpoint, as a Next App Router handler under
   `apps/cloud/app/api/email/events/[region]/route.ts`. `apps/cloud` has no `/v1` prefix; see PRD
   03's correction. Verify, parse, normalize, resolve tenant →
   environment, enqueue delivery.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2

4. **Normalizer.** SES notification JSON → `HogsendRelayEmailEvent`, the shape **PRD 04 owns and
   exports**. Import it; do not redeclare it. A duplicated literal on the two sides of this wire will
   drift, and the drift will show up as silently dropped bounce events rather than a type error.
   _Boundary:_ `apps/cloud` · _Depends:_ task 3

5. **Signed outbound delivery to the instance**, with bounded retry and a terminal-failure record.
   _Boundary:_ `apps/cloud` · _Depends:_ task 4

6. **Tests.** Every EARS line. Signature rejection cases get mutation-checked: break the allowlist,
   watch the SSRF test fail, restore. Include a round-trip test that runs a real SES notification
   fixture through the normalizer and into `plugin-hogsend.parseWebhook`, asserting the resulting
   `EmailEvent`.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3, 4, 5

## Seams

- Real SES notification fixtures should come from AWS's documented examples rather than being
  invented, so the normalizer is tested against the actual wire shape. Capture real ones once a live
  account exists (PRD 01) and replace the fixtures if they differ.

## Done when

A signed SES notification fixture travels end to end into a normalized `EmailEvent`, every rejection
case is tested and mutation-checked, and gates are green.

## Implementation Notes
</content>
