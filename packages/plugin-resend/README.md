# @hogsend/plugin-resend

Resend email delivery for [Hogsend](https://github.com/dougwithseismic/hogsend):
single + batch sends, tracked sends, webhook parsing/verification, and an email
service with bounce tracking.

`createResendProvider` is the **reference implementation** of the `EmailProvider`
contract — the contract itself lives in `@hogsend/core` (canonical author import
`@hogsend/engine`); this package re-exports `EmailProvider` and its supporting
types for back-compat. To support another provider, implement that interface. See
[docs/adr/0001-provider-boundary.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/adr/0001-provider-boundary.md).

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`). See the
[release model](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md).
