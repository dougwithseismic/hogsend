# @hogsend/plugin-meta-capi

## 0.44.0

### Minor Changes

- 820cceb: The revenue spine: first-class value on events, ad-click attribution capture, lead intake, a CRM deals ledger, conversion points, and server-side ad-platform feedback.
  - **Value on events**: `user_events` gains first-class `value numeric(14,2)` + `currency char(3)` — settable via `POST /v1/events`, `@hogsend/client` (`events.send({ value, currency })`), and `@hogsend/js` (`capture(name, props, { value, currency })`). Malformed money is dropped at ingest; every rollup is per-currency, never cross-summed. The analytics mirror forwards both.
  - **Ad-click attribution capture** (`@hogsend/js`): attributed landings (allowlisted click IDs — `fbclid`, `gclid`, `gbraid`, `wbraid`, `ttclid`, `msclkid`, `li_fat_id`, `twclid`, `rdt_cid`, `epik`, `sccid` — or `utm_*`) auto-fire **`campaign.arrived`** with a sessionStorage + server-idempotency dedup guard, persist the set as last-touch, and expose `getAttributionFields()` for form hidden fields. `@hogsend/core` ships the canonical click-ID allowlist and touchpoint event classifier.
  - **Lead intake**: `buildLeadSubmission` (`@hogsend/core`) normalizes any form vendor's webhook into the canonical **`lead.submitted`** event — `hs_anonymous_id` hidden-field identity stitching (browser session + ad clicks + lead land on ONE contact), first-class value passthrough, `submission_id` retry dedup.
  - **CRM deals ledger**: the `CrmProvider` contract (`defineCrmProvider`) with per-provider stage maps onto canonical stages (`lead → contacted → survey_booked → quoted → sold`, plus `lost`); webhooks at `POST /v1/webhooks/crm/:providerId` plus a 10-minute reconciliation poll; a **monotonic deals projection** (late webhooks never regress `sold`; `lost` never overwrites `sold`) minting once-per-deal-per-stage money events **`deal.quoted`** / **`deal.sold`** (+ `funnel.stage_changed`) on the outbound catalog; `crm_links` alias identity so email-less CRM webhooks still resolve the right contact. Reference providers for GoHighLevel, Attio, and HubSpot live in-repo (unpublished).
  - **Conversion points**: `defineConversion` — declare WHICH events count as valued conversions (condition `where` sees the first-class `value`, so "quotes over £10k" works), with a forged-value guard (browser/`pk_` events rejected by default), three value sources (event / fixed / property), and recorded-once semantics (unique on definition + event row).
  - **Conversion destinations**: `defineConversionDestination` + a durable dispatch pipeline — per-destination rows unique on (destination, event_id), a retrying Hatchet task, deterministic `event_id = sha256(contact:definition:eventRow)`, and click-evidence recovery (the contact's latest `campaign.arrived` at-or-before the conversion). New **`@hogsend/plugin-meta-capi`**: Meta Conversions API destination with per-Meta-spec hashing, `fbc` reconstructed from the real stored click (never fabricated), `action_source: system_generated`, and per-definition event naming for Conversion Leads funnel stages.
  - **Admin + Studio revenue surfaces**: `GET /v1/admin/deals` + `/stats` (per-currency sold 30d/lifetime, open pipeline, AOV, avg time-to-close); contacts list gains `minRevenue` + `dealStage` long-tail filters and a per-contact revenue rollup; Studio ships a **Deals** pipeline board with revenue stats and the new contact value filters.

### Patch Changes

- Updated dependencies [a2b49fd]
- Updated dependencies [0a1e2b7]
- Updated dependencies [55f7439]
- Updated dependencies [5949f25]
- Updated dependencies [820cceb]
- Updated dependencies [13dfcba]
  - @hogsend/core@0.44.0
