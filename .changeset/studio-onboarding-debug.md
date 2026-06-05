---
"@hogsend/studio": minor
---

Studio onboarding + a Debug (test-event) panel. A new **Debug** view fires events straight into `POST /v1/ingest` — the same path real events take — so journeys can be triggered locally without a PostHog tunnel; event presets are derived from the registered journeys' triggers. Empty states for Journeys and Buckets now link to the guides, the Overview shows a "getting started" card on a fresh install, and the sidebar gains a persistent Docs link.
