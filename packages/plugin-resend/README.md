# @hogsend/plugin-resend

Resend email delivery for [Hogsend](https://github.com/dougwithseismic/hogsend):
single + batch sends and webhook parsing/verification (svix), normalized into the
provider-neutral `EmailEvent` the engine consumes.

`createResendProvider` is the **reference implementation** of the provider-neutral
`EmailProvider` contract — the contract itself lives in `@hogsend/core` (canonical
author import `@hogsend/engine`); this package re-exports `EmailProvider` and its
supporting types for back-compat. To support another provider, implement that
interface (see the sibling `@hogsend/plugin-postmark`, or
[docs/byo-email-provider.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/byo-email-provider.md)).

Resend is the **default** provider; activate another with `EMAIL_PROVIDER` /
`email.defaultProvider`. Two sovereign invariants the engine enforces through this
provider:

- **First-party open/click tracking is the single source of truth.** Resend's
  native open/click tracking is an account-level toggle the provider can't disable
  per-send, so `capabilities.nativeTracking` is `true` and the engine logs a boot
  WARN — disable it in the Resend dashboard. Provider webhooks are consumed only
  for `delivered`/`bounced`/`complained`.
- **The engine renders React → HTML itself** before the wire; this provider's
  `send`/`sendBatch` only ever see HTML strings.

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`). See the
[release model](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md).
