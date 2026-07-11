# @hogsend/plugin-twilio

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
  - @hogsend/core@0.43.0
  - @hogsend/sms@0.43.0
