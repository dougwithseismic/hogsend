---
"@hogsend/engine": patch
"@hogsend/db": patch
"@hogsend/core": patch
"@hogsend/cli": patch
"@hogsend/client": patch
"@hogsend/email": patch
"@hogsend/plugin-posthog": patch
"@hogsend/plugin-resend": patch
"@hogsend/plugin-postmark": patch
"@hogsend/plugin-discord": patch
"@hogsend/plugin-telegram": patch
"@hogsend/studio": patch
"hogsend": patch
"create-hogsend": patch
---

Studio: an Events feed with source provenance + person drill-in, and event provenance on every ingested event.

Studio gains an **Events** view — a filterable, paginated feed of every event ingested
into the pipeline (`Event · Source · Person · Properties · Time`), with a **Live**
auto-refresh toggle. Clicking an event opens its properties as **typed key/value rows**
(string/number/boolean/null type chips); clicking the **person** opens the full contact
drawer (properties + email activity + a timeline of their other events). The contact
drawer also now renders the contact's **properties** (previously fetched but hidden).

To make "where did this event come from?" answerable, events now carry a **source**.
A new nullable `user_events.source` column (migration `0030`) is stamped at every
ingestion entry point: webhook sources record their id (so PostHog → `posthog`, Stripe
→ `stripe`, …), the public data-plane API → `api`, the Studio Debug panel + admin
enroll → `studio`, connectors → `connector`, journey triggers → `journey`, plus
`bucket` / `tracking` / `import`. The Events feed shows + filters by it.

The admin events list endpoint LEFT JOINs the live contact (matching the resolved key
across `externalId` / `anonymousId` / `id`) so each event carries its person's email +
contact id, and accepts a `source` filter. Pre-existing events have `source = null`.

The rest of the `@hogsend/*` line moves with this patch to stay on a single engine
version line.
