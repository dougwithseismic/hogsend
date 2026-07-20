---
"@hogsend/engine": minor
"@hogsend/studio": minor
---

Registry-fed pickers across the Studio: searchable two-pane selectors (PostHog-style list + detail pane) replace every free-typed identifier — events (trigger bolt, usedBy journeys, first/last seen, occurrences), people (server-searched, profile card with identity keys/groups/properties and an open-profile deep link), sources (registered connectors labeled and zero-backfilled, engine origins explained), plus a groups type filter, template/journey comboboxes, and open-vocabulary escape hatches everywhere. New admin endpoints: `GET /v1/admin/events/sources`, `GET /v1/admin/groups/types`, `firstSeenAt` on `/v1/admin/events/names`, `templates` on the targeting catalog, `providers` on deals stats, and a `/contacts?contact=<id>` deep link into the contact drawer.
