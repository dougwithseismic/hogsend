# @hogsend/core

Core types, Zod schemas, the condition-evaluation engine, duration helpers, and
the `JourneyRegistry` for [Hogsend](https://github.com/dougwithseismic/hogsend) —
a code-first lifecycle orchestration engine for teams on PostHog + Resend.

## Capability-provider contracts

Core also **owns** the capability-provider contracts — `EmailProvider` (with its
supporting `SendEmailOptions`, `BatchEmailItem`, `SendResult`, `WebhookEvent`,
`WebhookEventType`, `WebhookHandlerMap`) and `PostHogService` (with
`CaptureOptions`). These are the engine-owned contracts a swappable email/analytics
implementation satisfies; they live here and are re-exported by `@hogsend/engine`
(the canonical author import) and the vendor plugins (`@hogsend/plugin-resend`,
`@hogsend/plugin-posthog`) for back-compat. See
[docs/adr/0001-provider-boundary.md](https://github.com/dougwithseismic/hogsend/blob/main/docs/adr/0001-provider-boundary.md).

This package ships raw TypeScript source; consumers bundle it via their own build
(tsup `noExternal`). See the repo docs for the full architecture and the
[release model](https://github.com/dougwithseismic/hogsend/blob/main/docs/RELEASING.md).
