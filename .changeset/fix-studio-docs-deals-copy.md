---
"@hogsend/engine": patch
"@hogsend/studio": patch
---

Studio: fix 404 docs links in the Setup checklist and correct Deals copy that wrongly implied a CRM provider is required.

The attribution readiness checks (arrival capture, valued events, conversions firing, attribution credits) linked to `docs.hogsend.com/conversions/impact`, which is missing the `/docs/` path segment and 404s; they now point at `/docs/conversions/impact`. The remaining readiness checks and the Studio sidebar "Docs" link used a bare docs URL that resolved to the marketing homepage — each now points at its relevant docs page (hatchet, email, data-api auth, production email, PostHog setup, and the docs index).

The Deals view's "No deals yet" empty state told users to wire a CRM provider as the only way to get deals. Deals are event-native first — any ingested event matching a `defineFunnel` trigger mints a deal under the synthetic `events` provider — so a CRM is one optional source, not a requirement. The copy now leads with the event-native path and drops CRM-only framing from the "No deals match" state and the page header.
