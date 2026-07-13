---
"@hogsend/core": minor
"@hogsend/db": minor
"@hogsend/engine": minor
"@hogsend/studio": minor
"@hogsend/cli": minor
"@hogsend/client": minor
---

Impact — journey & event attribution, influence, and incrementality (docs/attribution-impact-plan.md, Phases 1–5):

- **Scope-dimensional credit**: `email_sends.campaign_id` (real column, backfilled from idempotency keys); journey/campaign scope stamped onto every touch event; `attribution_credits` gains journey/campaign/template/funnel columns with a pre-stamp fallback join; `ConversionMeta.scope` persisted and filterable; `GET /v1/admin/attribution` grows `groupBy=journey|campaign|template` plus credit filters; Studio gets a group-by picker and a journey-detail attributed-revenue card.
- **Windows & honesty**: per-channel attribution windows on `defineConversion` (`windows: { email: days(5), … }`, forward-only); last-touch labeled as the incumbent-comparable headline; cross-scope overlap read-out (what single-credit reporting would double-count); the email click bus re-ingest is now bot-gated (SafeLinks-style scanner sweeps no longer mint touches or trigger journeys — stats writes unchanged).
- **The non-monetary half**: `influenced` (model-invariant coverage, multi-counted by design) beside attributed; milestones documented as a convention; a first-reach `funnel_progress` reporting projection over event-native funnel transitions (per-contact per-stage timestamps, same gates as the deal mover); `GET /v1/admin/funnels/:id/progression` reports per-transition conversion + velocity with exposed-vs-unexposed splits, labeled correlational.
- **Incrementality**: per-journey holdouts (`holdout: { percent }` on journey meta) — deterministic hash diversion in the enrollment guard chain, `held_out` state rows, `journey.heldout` spine + outbound events; `GET /v1/admin/journeys/:id/lift` with beta-binomial win probability, a 10-combined-conversion suppression floor, and a small-sample flag; optional global control group (`GLOBAL_CONTROL_PERCENT`) withholding non-transactional email/SMS sends with a `contact.control_group` marker; PostHog person-property fan-out for both.
- **Day-one story**: `POST /v1/admin/attribution/backfill` + `hogsend attribution backfill` (idempotent history replay; guarded recompute); built-in zero-config `revenue` conversion (wildcard trigger, quote events excluded, opt-out via `HOGSEND_DEFAULT_REVENUE_CONVERSION=false`); attribution readiness rows on `GET /v1/admin/readiness`; the first-week guide at docs/conversions/impact.

Migrations 0051–0055. New outbound events `journey.heldout` and `contact.control_group` (catalog + vendored copies updated).
