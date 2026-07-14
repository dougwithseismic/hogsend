---
"@hogsend/db": minor
"@hogsend/core": minor
"@hogsend/plugin-posthog": minor
"@hogsend/engine": minor
"@hogsend/client": minor
"@hogsend/js": minor
"@hogsend/react": minor
"@hogsend/cli": minor
"@hogsend/studio": minor
---

Add first-class groups — account/team/company-level tracking, Hogsend's sovereign, standalone answer to PostHog group analytics.

A group is identified by its `(groupType, groupKey)` natural key and carries its own property bag and members. New `groups` + `group_memberships` tables (natural key partial-unique on live rows) and a `user_events.groups` per-event association map back the model DB-first: everything works with zero analytics provider. When PostHog is configured it's an automatic win — event associations forward as `$groups` and property writes call `groupIdentify` via the new optional group wire on the neutral `AnalyticsProvider` contract.

The security boundary is explicit: group property writes, membership mutations, and reads are secret-key only (the `/v1/groups` HTTP API, the `@hogsend/client` `groups.*` resource, and the HMAC-signed Segment `group` webhook). Publishable/browser keys may ONLY associate — attach a `groups` map to an ingested event via `hogsend.group()` (`@hogsend/js`) / `useGroup()` (`@hogsend/react`) → `POST /v1/events` — never write group properties or read groups.

Also ships: the Segment `group` integration, three outbound webhook events (`group.identified` / `group.member_added` / `group.member_removed`, emitted from the intent-layer routes only), and observe-only Studio views (groups list + detail). Group-level journeys are deliberately deferred — journeys stay person-scoped for now.
