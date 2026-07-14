# @hogsend/mcp

## 0.45.0

### Minor Changes

- 314a7e6: Engine version line 0.45.0 — first-run reliability release. Rides the line with the fresh-scaffold fixes (spaced-path engine migrations, pnpm 11 install settings, honest bootstrap with admin-key mint + in-flow PostHog connect, inert email boot, stored-credential PostHog activation).

### Patch Changes

- Updated dependencies [314a7e6]
  - @hogsend/engine@0.45.0

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

- ea059c5: Restrict the template test-send route to verified operator/team addresses.

  `POST /v1/admin/templates/{key}/send-test` (and the `@hogsend/mcp`
  `send_test_email` tool that wraps it) is reachable only with a `full-admin`
  key and sends with preference checks skipped. It previously accepted an
  arbitrary `to`, so a prompt-injected agent driving the MCP server could deliver
  a registered template — with attacker-controlled props — to any inbox,
  including suppressed recipients. The recipient is now bounded in the route
  handler — so it applies to the `send_test_email` tool and any other caller of
  this route — to the admin team: a row in the `user` table, or
  `HOGSEND_TEST_EMAIL` / `STUDIO_ADMIN_EMAIL`. Any other address returns `403`.
  A test send can now only ever reach your own team, never an arbitrary recipient.

- Updated dependencies [1f72740]
- Updated dependencies [b4669d8]
- Updated dependencies [a2b49fd]
- Updated dependencies [0a1e2b7]
- Updated dependencies [55f7439]
- Updated dependencies [5949f25]
- Updated dependencies [ea059c5]
- Updated dependencies [820cceb]
- Updated dependencies [13dfcba]
  - @hogsend/engine@0.44.0

## 0.43.0

### Minor Changes

- 45e2188: First-class SMS channel, mirroring the email architecture.
  - New `SmsProvider` contract in `@hogsend/core` (`defineSmsProvider`) — a dumb plain-text `send` + normalized-webhook (`SmsEvent`) wire; all preference/suppression/render/STOP logic lives in the engine.
  - New `@hogsend/sms` package: SMS templates authored as React components rendered to plain text (`renderSmsToText`), an augmentable `SmsTemplateRegistryMap`, and a GSM-7/UCS-2 segment counter.
  - New `@hogsend/plugin-twilio` (reference provider): send with retry + Twilio error classification, and `X-Twilio-Signature` webhook verification + inbound normalization. Opt-in via `TWILIO_ACCOUNT_SID`/`TWILIO_AUTH_TOKEN` + a sender; with no provider configured the SMS service is an inert stub and `sendSms` throws, so existing deploys are unaffected.
  - Engine: `SmsProviderRegistry`, env preset, the engine-owned `createTrackedSmsSender` (idempotency short-circuit with stored-body replay, suppression/consent gate, SMS frequency cap, journey `meta.suppress` min-gap, link rewrite, STOP footer, deploy-coherent test-mode redirect), a replay-safe `sendSms()` for journeys (disjoint `smsSend` key kind; auto-attributes `journeyStateId` from the boundary; passes the pipeline verdict through), `POST /v1/webhooks/sms/:providerId` (guarded-monotonic delivery-status callbacks + inbound STOP/START/HELP), `ctx.history.sms`, and `sms.sent`/`sms.delivered`/`sms.failed`/`sms.clicked` on the outbound catalog.
  - **Explicit consent (TCPA)**: the `sms` channel is opt-in (`defaultOptIn: false`, not configurable) — a marketing send needs an explicit `categories.sms === true` grant (`POST /v1/lists/sms/subscribe`, SDK, preference center) or phone-track consent (inbound START), else it fails closed (`no_consent`). Transactional sends bypass only the consent+topic gates — never the phone STOP list or `unsubscribed_all`. Every genuine grant emits the new **`contact.subscribed`** outbound event (the opt-in mirror of `contact.unsubscribed`) with `source` provenance.
  - **First-party SMS link tracking** (on by default): bare URLs in rendered bodies become `<host>/s/<code>` short links (8-char GSM-7-safe codes; `SMS_LINK_HOST` for a branded short domain, falling back to `API_PUBLIC_URL`; `SMS_LINK_TRACKING=false` disables) riding the existing `tracked_links` → `link_clicks` click spine — per-hit `sms.clicked` outbound, first-touch `sms_sends.clicked_at`, and the `sms.link_clicked` bus event for journeys (unfurl-bot-gated). The tracked rows commit in the same transaction as the send row, and crash replays reuse the stored body, so a code on the wire always resolves.
  - DB: `sms_sends` (+ `clicked_at`), `sms_suppressions` (tri-state: active STOP / express phone consent / none), a `contacts.phone` identity column, and `tracked_links.sms_send_id` + `short_code`.
  - Full TCPA/CTIA opt-out: an inbound STOP (whole-message or leading keyword, so "STOP texting me" counts) suppresses the phone in both the phone-keyed `sms_suppressions` table and the `sms` channel category on `email_preferences` (emitting `contact.unsubscribed`); START grants/resubscribes (emitting `contact.subscribed`).
  - The outbound catalog grows to 21 events (`contact.subscribed`, `sms.sent`, `sms.delivered`, `sms.failed`, `sms.clicked`); the `@hogsend/client` event union also picks up the previously-missing `link.clicked`/`link.arrived`.

### Patch Changes

- Updated dependencies [45e2188]
  - @hogsend/engine@0.43.0

## 0.42.0

### Minor Changes

- 57e6272: New `@hogsend/mcp` package — a distributable Model Context Protocol server for a running Hogsend instance.
  - New publishable `@hogsend/mcp` package with two transports over one tool implementation: **stdio** (`npx @hogsend/mcp`, for Claude Desktop / Cursor / any local client) and **Streamable HTTP** — a consumer-mounted route (`mcpRoutes()` passed to `createApp`'s `routes` option) served at `POST /v1/mcp` for claude.ai connectors. The hosted route is admin-gated by the engine's existing `requireAdmin` and runs each tool call in-process with the caller's own credential, so there is no new engine dep and no parallel auth path.
  - Surface: three tools (`manage_blueprint` — create/update/validate/enable/disable Journey Blueprints; `hogsend_report` — a read-only health report with severity-ranked findings across the health/blueprints/journeys/deliverability/catalog scopes; `send_test_email`), the `hogsend://blueprint-authoring-guide` resource, and the `find_and_fix_bottleneck` prompt.
  - Engine changes backing it: new `GET /v1/admin/api-keys/self` (returns the calling credential's identity) and `GET /v1/admin/events/names` read routes, `requireAdmin` exported from the engine barrel, the blueprint authoring-guide extracted into a shared env-free `@hogsend/engine/mcp/authoring-guide` export, blueprint `409` conflict bodies now carry a machine-readable `code`, and stricter `entryPeriod` / `within` schema validation.

### Patch Changes

- Updated dependencies [d7328a3]
- Updated dependencies [6e17712]
- Updated dependencies [01ac1f3]
- Updated dependencies [df76ac6]
- Updated dependencies [57e6272]
  - @hogsend/engine@0.42.0
