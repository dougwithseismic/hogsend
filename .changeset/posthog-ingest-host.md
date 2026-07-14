---
"@hogsend/plugin-posthog": minor
---

feat: export `deriveIngestHost` — the inverse of `derivePrivateHost` (`https://eu.posthog.com` → `https://eu.i.posthog.com`; self-hosted and already-ingestion hosts pass through unchanged). Used by the engine to pick a capture host when the only stored host is the private one from `hogsend connect posthog`.
