---
"@hogsend/engine": minor
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/cli": minor
"@hogsend/client": minor
"@hogsend/email": minor
"@hogsend/plugin-posthog": minor
"@hogsend/plugin-resend": minor
"@hogsend/plugin-postmark": minor
"@hogsend/plugin-discord": minor
"@hogsend/studio": minor
"hogsend": minor
---

PostHog identity stitching across web, email, server & Discord.

Establishes one canonical, ever-identified `distinct_id` per person (the Hogsend
contact key) and absorbs every other id into it while still anonymous, fixing
the one-email-many-persons fragmentation.

- `@hogsend/core`: provider-neutral `mergeIdentities` + `identityMerge`
  capability on the `AnalyticsProvider` contract (both optional; `distinctId` is
  the surviving/canonical id, `alias` the absorbed anonymous one).
- `@hogsend/plugin-posthog`: `mergeIdentities` via native `client.alias` in the
  correct (PostHog docs) direction, fire-and-forget.
- `@hogsend/engine`: `mergeAnalyticsIdentities` helper + two resolver emission
  points (collide-merge + key-flip) with identified-key filtering and
  idempotency so a retry never re-aliases; `/v1/events` `anonymousId` threading
  so the contact key can equal the browser anon id (zero-merge); identity-bearing
  tracked links (`link.clicked` event, scoped tokens, server-side alias at
  `/v1/t/identify`) with referral links token-less by default (anti-hijack).
- `@hogsend/client`: optional `anonymousId` on event/contact inputs.
- `@hogsend/plugin-discord`: `/link` contact-merge propagates a PostHog merge via
  the shared identity service.

Additive and off by default; no forced migration. The other engine-line packages
ride the same minor to keep the version line uniform.
