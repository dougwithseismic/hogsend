---
"@hogsend/engine": minor
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/studio": minor
"hogsend": minor
"create-hogsend": minor
---

Provider-neutral analytics: the `AnalyticsProvider` contract (the analytics
sibling of `EmailProvider`, authored via `defineAnalyticsProvider`) lands in
`@hogsend/core`, with person reads (`getPersonProperties`), person writes
(`setPersonProperties` — `set`/`setOnce`/`unset`), and capture.
`createHogsendClient`'s `analytics` option now mirrors `email`
(`{ provider?, providers?, defaultProvider? }`, env preset + consumer-last,
`ANALYTICS_PROVIDER` selection); legacy `PostHogService` inputs are
adapter-wrapped and keep working. `client.analyticsProviders` is the registry,
`client.analytics` the resolved active provider.

PostHog person reads are FIXED — they were silently dead (the write-only
`phc_` project key sent to the ingestion host at a legacy path). Reads now use
`POSTHOG_PERSONAL_API_KEY` (a personal API key scoped `person:read`) against
the private API host (derived from `POSTHOG_HOST`, override
`POSTHOG_PRIVATE_HOST`) with one-shot project-id discovery (override
`POSTHOG_PROJECT_ID`). Without the personal key, reads soft-fail to contact
property fallbacks — now surfaced once at boot and by `hogsend doctor`
instead of silently. Person WRITES need no extra credential (they ride the
capture pipeline as `$set`/`$set_once`/`$unset`); `createPostHogProvider` is
the reference implementation. The scaffold's `env.example` documents the
two-credential model. (The full engine line rides together per release
discipline.)
