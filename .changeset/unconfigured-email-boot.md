---
"@hogsend/engine": minor
---

feat: boot cleanly without email creds, and activate PostHog capture from the stored `hogsend connect posthog` credential

- **No email provider ≠ boot crash.** When no provider is registered and none was explicitly requested (`EMAIL_PROVIDER` / `email.defaultProvider`), the container now boots with an inert stub (mirroring the SMS channel's operator-opt-in posture): Studio, ingest and non-email journeys all work, and each send fails per-call with an actionable message. Explicitly-requested provider ids still fail loud at boot (typo safety), as does an implicit default when other providers are registered. Fresh scaffolds no longer need a placeholder `RESEND_API_KEY` just to boot.
- **Honest native-tracking warning.** The boot warning for providers whose open/click tracking is account-level (Resend) no longer claims the account "reports tracking ON" — it's a static capability, not a live probe — and now says what to actually do.
- **The persisted phc_ is no longer dead weight.** `hogsend connect posthog` stores the discovered project API key in `provider_credentials` (kind `derived`), but nothing ever read it back at boot — outbound capture silently kept requiring a hand-pasted `POSTHOG_API_KEY`. The container now runs `activateStoredPosthogAnalytics` right after construction: when no analytics provider resolved and `POSTHOG_API_KEY` is unset, the PostHog provider is built from the stored credential (capture host derived from the stored private host, e.g. `eu.posthog.com` → `eu.i.posthog.com`) and activated — registry, `client.analytics`, the module singleton and the identity service all rebind. The PostHog path is now deploy → `hogsend connect posthog` → done, no keys pasted.
