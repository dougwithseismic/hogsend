# PRD 15 — Configurable subdomains and setup guidance

**Status:** `[ ]` · **Depends:** 07, 14 · **Boundary:** `apps/cloud`, `packages/engine`

## Goal

Two gaps the first customer would hit, plus the advice that stops them hurting themselves.

1. **The return-path subdomain is hardcoded `send.`** (`MAIL_FROM_SUBDOMAIN = "send"` in
   `lib/sending-domains.ts`). A customer who wants `notifications.mycustomer.com` cannot have it.
2. **Nothing tells them to send from a subdomain at all.** Verifying the ROOT domain works and is
   the obvious thing to type, and it is the wrong default: it puts the reputation of the domain that
   carries their payroll, contracts and password resets behind a marketing blast.

## The distinction this PRD exists to keep straight

**Return-path MX ≠ reply MX.** The MX in `mailFromRecords` points at
`feedback-smtp.<region>.amazonses.com` and carries BOUNCES. Replies route on the MX of the domain in
`From`/`Reply-To` and have nothing to do with it. Receiving replies is SES inbound receiving —
PRD 16, a different feature. Do not let this PRD drift into that one.

## Locked decisions

- **Sending from a subdomain ALREADY WORKS and must not be rebuilt.** `createIdentity({ domain })`
  takes any string, so `notifications.mycustomer.com` verifies exactly like a root domain. The gap is
  guidance, not capability. **Verify this against the live walkthrough before writing code**, and if
  it turns out subdomains do NOT work, stop and report — that would be a much bigger finding.
- **The one-TXT-record default STAYS.** The branded return path remains opt-in. It is the
  competitive wedge (Resend asks for three records) and the fastest path to a verified domain. It is
  surfaced prominently in setup with its tradeoff stated, rather than switched on for everyone.
  **Doug asked for MX+SPF by default, and the stated reason was replies — which the return path does
  not provide.** If he still wants it on by default knowing that, it is a one-line default change,
  but it is his call and this PRD does not make it silently.
- **The label is validated, not free text.** A single DNS label: `/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/`,
  lowercased. Reject anything else rather than emitting a record that cannot be published.
- **Changing the label on a live domain is a migration, not an edit.** The old MAIL FROM must be
  reverted and the new records published before the switch takes effect, or mail flows through a
  MAIL FROM whose MX no longer resolves. `BehaviorOnMxFailure: USE_DEFAULT_VALUE` keeps that from
  becoming an outage, which is exactly why DECISIONS §2 chose it — but the flow must still sequence.
- **`send` stays the default label.** An existing customer who never chose one sees no change.

## Acceptance criteria (EARS)

- WHEN a domain is created with no explicit return-path label, the system SHALL use `send`, and the
  emitted records SHALL be byte-identical to today's.
- WHEN a customer supplies a return-path label, the system SHALL use `<label>.<domain>` for the MAIL
  FROM domain and for both the MX and SPF records.
- WHEN a supplied label is not a valid single DNS label, the system SHALL reject it with a message
  naming the rule, and SHALL NOT call SES.
- WHEN the label changes on a domain whose return path is already enabled, the system SHALL report
  the new records as `pending` and SHALL NOT report the domain as fully configured until SES confirms.
- WHEN a customer is setting up a domain, the UI SHALL recommend a dedicated sending subdomain and
  SHALL state the reason: root-domain reputation is shared with the mail they cannot afford to lose.
- WHEN a customer enters a root domain anyway, the system SHALL allow it and SHALL NOT block them.

## Tasks

1. **Confirm subdomain sending against the live walkthrough** (`--identity-domain`). Evidence first.
   _Boundary:_ none · _Depends:_ none
2. **Thread an optional return-path label** through `sending-domains.ts`, the domains service and the
   control-plane endpoints, defaulting to `send`. Validate it.
   _Boundary:_ `apps/cloud` · _Depends:_ task 1
3. **Setup guidance copy** wherever a domain is entered — recommend `notifications.` / `mail.` /
   `updates.`, state the root-domain risk in one sentence, no hedging.
   _Boundary:_ `packages/engine` · _Depends:_ none
4. **Tests.** Default unchanged (byte-identical records), custom label, invalid labels rejected,
   relabel-while-live sequencing.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 2, 3

## Seams

- Whether Doug wants the branded return path ON by default, now that he knows it does not deliver
  replies. One-line change either way.

## Done when

A customer can choose their return-path subdomain, the default is unchanged for everyone who does
not, setup tells them to use a subdomain and why, and gates are green.

## Implementation Notes
