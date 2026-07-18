---
"@hogsend/engine": minor
"@hogsend/cli": minor
"@hogsend/client": minor
---

Weekly `impact.digest` outbound event: an engine-owned cron (Mondays
09:00 UTC by default, `IMPACT_DIGEST_CRON`) detects newly shipped journey
versions/labels and holdout-lift win-probability crossings
(`IMPACT_DIGEST_WIN_PROB`, default 0.95, clamped 0.5–0.999) and emits one
facts-only digest to subscribed webhook endpoints — inert with no
subscriber. The outbound catalog grows to 30 events; the PostHog and
Segment destination presets skip the person-less digest event. Shipped
entries are structurally observational (no lift fields on the type); lift
entries are holdout-backed causal.
