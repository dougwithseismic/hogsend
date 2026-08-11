# PRD 18 — Consume SES `Reject`

**Status:** `[ ]` · **Depends:** 05, 14 · **Boundary:** `apps/cloud`, `packages/core`, `packages/engine`, `packages/plugin-hogsend`

## Goal

Learn when SES accepts a message and then throws it away.

`SES_PUBLISHED_EVENT_TYPES` subscribes to four event types and its comment says `SEND` and `REJECT`
are absent "because the relay already knows what it sent." **That is true of `SEND` and false of
`REJECT`**, and the difference is a message that never reaches a terminal state.

## The primary source

AWS, *Contents of event data that Amazon SES publishes to Amazon SNS*, the Reject object:

> "The reason the email was rejected. The only possible value is `Bad content`, which means that
> Amazon SES detected that the email contained a virus. **When a message is rejected, Amazon SES
> stops processing it, and doesn't attempt to deliver it to the recipient's mail server.**"

A `Reject` therefore arrives AFTER the send call returned a message id. There is no bounce, no
delivery, and no later event. Today that `email_sends` row stays non-terminal permanently: the
customer sees a send that looks fine and a recipient who never received anything, with nothing
anywhere to explain it.

**PRD 17 makes this materially worse.** Virus detection is the ONLY reject reason, and PRD 17 is
about to let customers attach arbitrary files. Shipping attachments without consuming `Reject` means
shipping the exact failure mode we have no visibility into.

## The decision that shapes the implementation

**A Reject is OUR fault, not the recipient's.** The address is fine; the content carried a virus.

So a Reject must terminate the send **without suppressing the recipient**. Mapping it onto
`email.bounced` would be the obvious shortcut and it would be wrong: `permanent` auto-suppresses, so
one bad attachment would permanently block a good address, and the customer would never be able to
mail that person again. That is a data-loss bug wearing a reuse-the-existing-type costume.

It therefore needs its own neutral type, `email.rejected`, which marks the send terminal and
suppresses nothing.

## Locked decisions

- **Add `REJECT` to `SES_PUBLISHED_EVENT_TYPES`** and correct the comment, which currently states a
  reason that is only half true.
- **Add `email.rejected` to `EmailEventType`** in `@hogsend/core`. It is provider-neutral by
  construction — Postmark has `SpamComplaint`/`Blocked`, Resend has its own — even if only the
  Hogsend provider emits it today.
- **`email.rejected` NEVER suppresses.** Assert it, and mutation-check the assertion, because the
  failure is silent and permanent.
- **It IS terminal.** `email_sends` reaches a final status; no later event is coming.
- **Existing deploys are unaffected.** A provider that never emits the type behaves identically.
  Configuration sets already provisioned keep their four types until re-provisioned, so the change
  must be idempotent on re-drive rather than assuming a fresh tenant.
- **The reason string travels verbatim.** `Bad content` is the only documented value today; do not
  parse it, map it, or assume it stays the only one.

## Acceptance criteria (EARS)

- WHEN a tenant's configuration set is provisioned, the system SHALL subscribe to `REJECT` alongside
  the existing four types.
- WHEN a tenant provisioned before this change is re-driven, the system SHALL add `REJECT` without
  duplicating the destination or failing on the existing one.
- WHEN a valid SES `Reject` notification arrives, the system SHALL normalize it to
  `type: "email.rejected"` carrying the reason verbatim.
- WHEN an `email.rejected` event is handled, the system SHALL mark the send terminal and SHALL NOT
  add the recipient to any suppression list, SHALL NOT increment `bounceCount`, and SHALL NOT affect
  the tenant's bounce rate.
- WHEN a journey waits on delivery, an `email.rejected` SHALL resolve it as undelivered rather than
  leaving it waiting forever.

## Tasks

1. **Add `REJECT` to the published set**, correct the comment, and confirm the re-drive path is
   idempotent.
   _Boundary:_ `apps/cloud` · _Depends:_ none
2. **`email.rejected` on `EmailEventType`** + the relay event union in `plugin-hogsend`.
   _Boundary:_ `packages/core`, `packages/plugin-hogsend` · _Depends:_ none
3. **Normalize** SES `Reject` → `email.rejected` in the ingress normalizer.
   _Boundary:_ `apps/cloud` · _Depends:_ tasks 1, 2
4. **Engine handling**: terminal status, no suppression.
   _Boundary:_ `packages/engine` · _Depends:_ task 2
5. **Tests**, including the no-suppression assertion, mutation-checked.
   _Boundary:_ all touched · _Depends:_ tasks 1-4

## Seams

- Unverifiable against real AWS without deliberately sending a virus test file (EICAR) through a
  verified domain. Worth doing once the live send path exists; not a build blocker.

## Done when

`REJECT` is subscribed, a Reject notification produces a terminal non-suppressing `email.rejected`,
the no-suppression assertion is mutation-checked, and gates are green.

## Implementation Notes
