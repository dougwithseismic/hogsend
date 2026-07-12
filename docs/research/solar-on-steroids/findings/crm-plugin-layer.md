# Research: crm-plugin-layer

## CRM Delivery + Sync-Back Layer: Design Inputs for a Pluggable `CRMProvider` System

This report covers the seven CRMs Solar on Steroids (SOS) advertises direct integrations for — GoHighLevel, HubSpot, Attio, Salesforce, Monday, Pipedrive, Payaca — plus the bridge-product landscape and a normalized plugin contract. The strategic point of SOS's system is that **it optimises Meta campaigns on cost-per-quote and cost-per-sale, not cost-per-lead**. That only works if the CRM layer can reliably do one thing: detect a pipeline stage change (lead → quoted → sold) *and read the deal value* out of the CRM, then fire a CAPI event with `fbclid`/`ad_id` matched back to the original submission. Everything below is judged against that single requirement.

### 1. Comparison table (7 CRMs)

| Axis | **GoHighLevel** | **HubSpot** | **Attio** | **Salesforce** | **Monday** | **Pipedrive** | **Payaca (UK trades)** |
|---|---|---|---|---|---|---|---|
| **Auth** | OAuth 2.0 (v2 exclusive; API keys deprecated) | OAuth 2.0 (multi-account) or Private App static token (single account) | OAuth 2.0 or workspace API key | OAuth 2.0 (JWT bearer for server-to-server) | OAuth 2.0 or API token / shortLivedToken | Personal API token or OAuth 2.0 | HMAC (`developer-id` + `user-id` + `user-api-key`) — *see caveat* |
| **Contact create** | `POST /contacts/` + upsert endpoint | Contacts API (CRM objects) | People object (`POST` records) | `POST` sobjects/Contact or Lead | `create_item` GraphQL mutation | Persons endpoint | Contacts endpoint (REST) |
| **Deal/opportunity create** | `POST /opportunities/` (leadconnectorhq.com) | Deals API | Deals object (`POST` records) | `POST` sobjects/Opportunity | Item on a "deals" board | Deals endpoint (v2) | Not clearly documented; Quick Invoices / Recurrings exist |
| **Deal value field** | `monetaryValue` | `amount` property | `value` attribute (currency type) | `Amount` | a numeric/currency **column** (per-board) | `value` (+ currency field) | Undocumented publicly |
| **Stage model** | Pipeline → `pipelineStageId` (+ `status` open/won/lost) | Pipeline → `dealstage`; also `lifecyclestage` on contacts | Deal `stage` (status attribute, per-workspace) | `StageName` picklist per sales process | `status`/`dropdown` **column** per board | `stage_id` within a pipeline | Undocumented; job status likely |
| **Native outbound webhook on stage change** | ✅ `OpportunityStageUpdate` / opportunity events | ✅ `deal.propertyChange` + `deal.stageChange` subscriptions | ✅ `record.updated` (fires on attribute change) | ⚠️ No true webhook — Change Data Capture / Platform Events / Outbound Messages (all admin-configured in-org) | ✅ board-level `change_column_value` webhook | ✅ Webhooks v2 (`updated.deal`), free, no token cost | ⚠️ "Post Back Configs" (postbacks) exist; events undocumented |
| **Deal value IN the webhook payload?** | ✅ **Yes** — payload carries `monetaryValue`, `pipelineStageId`, `status`, `contactId` | ⚠️ **Partial** — payload has `objectId`, `propertyName`, `propertyValue` only; must fetch deal for full context | ❌ **No** — payload gives `object_id`/`record_id`/`attribute_id` + actor; **must GET the record** to read value | Depends: CDC/Platform Event payloads can carry changed fields; Outbound Message carries the record | ⚠️ `change_column_value` gives previous+new column value for the changed column only | ✅ **Yes** — v2 webhook delivers the full deal object incl. `value` and `stage_id` | Unknown |
| **Polling fallback** | Search Opportunity endpoint | Search/List deals + `hs_lastmodifieddate` filter | List/query records with filters + `sort` | REST/SOQL query on `LastModifiedDate` | GraphQL query board items | List deals `since`/`updated` | GET Contacts / poll postback state |
| **Rate limits** | 100 req / 10s burst; 200k/day **per app per resource** | Burst ~110 req / 10s per account (OAuth); tiered daily; 1,000 webhook subs/app | ~25 req/s (per target URL for webhooks); API tiered | Per-org daily API limits; CDC 72h retention, 5-entity cap w/o add-on; 2,000 concurrent subscribers | Complexity-budget (~10M complexity/min/account) | Token budget: 30k base × plan multiplier × seats/day; 2s burst window; webhooks free | Undocumented |
| **Dedup / upsert** | Contact upsert endpoint (email/phone match); "find-before-update" for opps | Search API then create/update; no atomic upsert by arbitrary field | `assert`/matching-attribute upsert on records | `PATCH` upsert by External ID field | No native upsert — query then create/update | Search then update; no atomic upsert | Undocumented |

**Ranking by integration ease for the "stage-change + value → CAPI" job:** Pipedrive and GoHighLevel are best (full object incl. value in the webhook). HubSpot is good but needs a follow-up fetch. Attio needs a mandatory fetch-after-webhook. Monday is workable but every client's board is a bespoke column schema. Salesforce is the heaviest — no zero-config webhook; you depend on the client's admin enabling CDC/Platform Events/Outbound Messages, or you poll. Payaca is the wildcard (see §4 caveat).

### 2. The normalized `CRMProvider` contract

The plugin's whole job is to turn N heterogeneous CRMs into one **canonical funnel event stream** the attribution engine consumes. Canonical stages, mirroring SOS's model: `lead → contacted → survey_booked → quoted → sold` (plus terminal `lost`).

```ts
interface CanonicalFunnelEvent {
  sosId: string;          // your own UID minted at form submission — the join key
  clientId: string;
  crm: CrmVendor;
  crmId: string;          // native contact/deal id
  stage: CanonicalStage;  // lead|contacted|survey_booked|quoted|sold|lost
  dealValue?: Money;      // { amount, currency }
  occurredAt: string;     // when the CRM change happened, not when we saw it
  raw: unknown;           // verbatim provider payload for replay/audit
}

interface CRMProvider {
  meta: { id: CrmVendor; name: string; capabilities: CrmCapabilities };

  // OUTBOUND: push the lead into the client's CRM
  pushLead(input: LeadInput, opts: { idempotencyKey: string }): Promise<{ crmId: string }>;

  // INBOUND (webhook path): verify + normalize a provider webhook to canonical events
  verifyWebhook(req): Promise<void>;                 // throws on bad signature
  parseWebhook(payload): Promise<CanonicalFunnelEvent[]>;

  // INBOUND (poll path): pull records changed since a cursor
  poll(cursor: string | null): Promise<{ events: CanonicalFunnelEvent[]; nextCursor: string }>;

  // enrichment: some providers only send an id → fetch the full record
  hydrate(crmId: string): Promise<{ dealValue?: Money; stage: string; fields: Record<string,unknown> }>;
}

interface CrmCapabilities {
  auth: "oauth" | "apiKey" | "hmac";
  nativeStageWebhook: boolean;   // GHL/Pipedrive/HubSpot/Monday=true; SF=false; Attio=true(but thin)
  valueInWebhookPayload: boolean;// GHL/Pipedrive=true; HubSpot/Attio/Monday=false → hydrate()
  atomicUpsert: boolean;         // GHL/SF(extId)/Attio=true; others=false
  webhookConfigRequiresAdmin: boolean; // SF=true (CDC/Outbound Msg); Monday=per-board
}
```

Required sub-systems:

**(a) Lead push with idempotency.** Mint your own `sosId` UID at Perspective form submission (SOS's `perspectiveId`/`sosId`). Use it as the idempotency key so retries and Perspective's double-fires don't create duplicate contacts. Where the CRM supports atomic upsert (GHL contact-upsert, Salesforce External-Id `PATCH`, Attio assert), use it; where it doesn't (HubSpot, Pipedrive, Monday), implement search-before-create keyed on email+phone, and store the returned `crmId ↔ sosId` mapping in your own table so you never re-search.

**(b) Field mapping (declarative, per-client).** Every client's CRM has a different schema. Store a per-client mapping doc: `{ canonicalField → providerFieldRef }`. Provider field refs differ wildly — HubSpot internal property names, Pipedrive 40-char hashes, Monday `column_id`s, Salesforce API names, Attio attribute slugs. The mapping must round-trip both ways (push writes `appeal/product/postcode/utm_*`; inbound reads `dealValue/stage`).

**(c) Stage mapping config.** The load-bearing piece. Each client maps *their* arbitrary pipeline stages → your canonical funnel events: `{ providerStageId/Name → CanonicalStage }`. For GHL a client might have `pipelineStageId: abc → survey_booked`; for Salesforce a picklist `"Site Survey Booked" → survey_booked`. Sold detection is per-provider: GHL `status: "won"`, Pipedrive `status: "won"`, HubSpot `dealstage == closedwon`, Salesforce `IsWon/StageName`. Keep this as data, not code, so onboarding a client is a config task not a deploy.

**(d) Deal-value extraction.** Two classes: **value-in-payload** (GHL `monetaryValue`, Pipedrive `value`) — read directly; **value-by-fetch** (Attio, HubSpot property-change, Monday, Salesforce CDC-lite) — the webhook only tells you *something changed*, so call `hydrate(crmId)` to read the current `value` + `stage`. Always normalize to `{ amount, currency }`; never assume GBP even for UK installers (SOS is expanding to US → USD).

**(e) Webhook-vs-poll strategy per provider.** Prefer webhook where the payload carries value (GHL, Pipedrive). Use webhook-then-hydrate where it doesn't (HubSpot, Attio, Monday). Use **poll as the primary path for Salesforce** unless the client's admin will provision CDC/Outbound Messages, and as a **safety-net reconciliation poll for all providers** (webhooks drop). SOS's own system log shows exactly this hybrid — `crm.poll` checking for stage changes *and* `POST /webhooks/crm` — confirming they run both per CRM.

**(f) Backfill / replay.** Persist the raw payload on every canonical event. Keep a per-client cursor for the reconciliation poll. On onboarding, backfill historical won deals via a bounded poll so the client's leaderboard/attribution isn't empty. Idempotency on the CAPI side keyed on `(sosId, stage)` so a webhook + a poll seeing the same sold event fires CAPI once.

### 3. Failure modes to design against

- **Duplicate contacts.** The #1 problem. Perspective can submit twice; a CAPI `fbclid` visit + later organic visit is the same person; CRMs without atomic upsert create twins. Mitigate with `sosId`-keyed idempotency + email/phone dedup + your own `crmId↔sosId` map. This is also why SOS's cross-session stitching (FB click without fill → later organic fill → stitch to first touch) matters: identity resolution happens *before* the CRM push.
- **Stage renames.** Clients rename pipeline stages in the CRM UI; your stage-map keys on `pipelineStageId` (stable) where possible, on stage *name* only as last resort (Salesforce picklists, Monday statuses are name/label-based → brittle). Alert on unmapped stages rather than silently dropping.
- **Multi-pipeline clients.** A client may run "Residential Solar", "Battery Retrofit", "Commercial" pipelines with different stage sets. Stage-map must be keyed on `(pipelineId, stageId)`, not stageId alone. GHL, HubSpot, Pipedrive, Salesforce all allow many pipelines.
- **Deleted / merged deals.** A won deal deleted or merged post-CAPI shouldn't retract the ad signal automatically, but you need `delete.deal` webhooks logged for reconciliation and to avoid re-firing on a resurrected id.
- **Currency.** Mixed-currency once US clients land. Store currency on every value; never sum across currencies for the leaderboard without conversion; CAPI value must be sent in the currency Meta expects per pixel.
- **Value on the wrong object.** GHL puts value on the *opportunity*; some clients track value as a *contact custom field* or on an invoice (Payaca). The mapping must allow value to come from a different object than the stage.
- **Webhook loss & ordering.** Providers don't guarantee delivery or order; a `sold` can arrive before `quoted`. Treat canonical stages as a monotonic max (once `sold`, ignore later `quoted`), and run the reconciliation poll to heal gaps.
- **HMAC/secret rotation & OAuth token refresh.** Store per-client tokens, refresh proactively (Pipedrive/HubSpot/GHL tokens expire); fail closed and alert rather than silently stop syncing.

### 4. How "bespoke if API available" translates into plugin-architecture requirements

SOS's public posture — "GoHighLevel, HubSpot, Salesforce, Monday, Pipedrive, Payaca, and bespoke if an API is available" — is exactly an argument for the plugin contract above rather than N hand-rolled integrations. Concretely:

1. **A thin, uniform `CRMProvider` interface** (§2) so a new "bespoke" CRM is a single new module implementing 5 methods + a capabilities descriptor — the same shape as SOS clearly runs internally (their log shows one normalized event schema regardless of source CRM).
2. **Capability flags drive behaviour, not branching code.** `valueInWebhookPayload`, `nativeStageWebhook`, `atomicUpsert`, `webhookConfigRequiresAdmin` let the orchestrator pick webhook-vs-poll and upsert-vs-search per provider without special-casing.
3. **Config-as-data onboarding.** Field map + stage map + value-source are per-client JSON, so "bespoke if API available" becomes: write the transport adapter once, then onboard each client purely through mapping config — matching SOS's "clients control publication granularity" and per-client `clientId` scoping.
4. **A generic long-tail adapter.** For a CRM with only a REST API and outbound webhooks (the Payaca-class case), a configurable generic adapter (define endpoints, auth, field paths, and a `transform(payload) → CanonicalFunnelEvent` — structurally identical to Hogsend's own `defineWebhookSource`) covers "any CRM with an API" without new code. Poll-only mode is the floor when a CRM has no outbound webhooks at all.
5. **Consent/provenance capture is part of the record, not the CRM.** SOS stores via UIDs, no PII beyond 29 days, GDPR-first (UK, so consent not US TCPA). ActiveProspect/TrustedForm-style certification is US-centric and largely irrelevant here; the UK/GDPR equivalent is a **consent + provenance ledger** attached to the lead at submission (source page, timestamp, IP, UTM set, consent checkbox state) — which the plugin should push as fields and retain independently of the CRM, since CRMs are inconsistent about storing consent metadata.

**Bridge-product gap (why build vs. buy Zapier/Make/LeadsBridge/AnyTrack).** LeadsBridge already does "CRM pipeline-stage-change → Meta CAPI funnel event with stored FBCLID" — this is precisely SOS's mechanism, so the *concept* is commoditised. What off-the-shelf bridges miss, and what SOS sells for £40k–£100k: (a) **deal-value-weighted** optimisation (cost-per-sale, not just event count) — bridges fire an event, they don't reconcile the £17,124 value back and treat it as the optimisation target; (b) **cross-session first-touch stitching** (FB click → no fill → later organic fill → attribute to first ad) which requires your own UID/session store, not the CRM's; (c) a **multi-model attribution engine** on top (first/last/linear/time-decay/position/blended) — bridges are single-hop pipes with no attribution model; (d) **per-client mapping at agency scale** (54 clients, 7 CRM types) with a public leaderboard/data-feed as the trust artifact. The moat is not the CAPI call; it's the normalized value+stage store and the attribution layer sitting on top of a robust `CRMProvider` abstraction.

**CAVEAT on Payaca:** The only public "Payaca" API docs I could reach (`docs.payaconnect.com`, "Paya Connect", HMAC auth, Quick Invoices/Recurrings/Post Backs) appear to be **Paya/Paya Connect, a US payments gateway — a different company from Payaca, the UK solar/heat-pump/trades CRM at payaca.com**. Payaca (UK) advertises a "full API" and API connectivity but does not expose public developer docs in search; access likely requires contacting them / partner onboarding. Treat Payaca as a poll-first, thin-adapter target until its real API surface is confirmed directly.

### Sources
- GoHighLevel: https://marketplace.gohighlevel.com/docs/ ; opportunity webhook + `monetaryValue`/`pipelineStageId`/`status`: https://marketplace.gohighlevel.com/docs/webhook/OpportunityAssignedToUpdate/index.html ; create opportunity: https://marketplace.gohighlevel.com/docs/ghl/opportunities/create-opportunity/index.html
- HubSpot: https://developers.hubspot.com/docs/developer-tooling/platform/usage-guidelines ; webhooks: https://developers.hubspot.com/docs/api/webhooks ; https://hookdeck.com/webhooks/platforms/guide-to-hubspot-webhooks-features-and-best-practices
- Attio: https://docs.attio.com/rest-api/overview ; webhooks guide: https://docs.attio.com/rest-api/guides/webhooks ; record.updated: https://docs.attio.com/rest-api/webhook-reference/record-events/recordupdated ; auth: https://docs.attio.com/rest-api/guides/authentication
- Salesforce: https://developer.salesforce.com/docs/atlas.en-us.platform_events.meta/platform_events/platform_events_intro.htm ; https://hookdeck.com/webhooks/platforms/guide-to-salesforce-webhooks-features-and-best-practices
- Monday: https://developer.monday.com/api-reference/docs/basics ; https://hookdeck.com/webhooks/platforms/guide-to-monday-webhooks-features-and-best-practices
- Pipedrive: https://developers.pipedrive.com/docs/api/v1/Webhooks ; rate limits: https://pipedrive.readme.io/docs/core-api-concepts-rate-limiting ; token-based limits: https://developers.pipedrive.com/changelog/post/breaking-changes-token-based-rate-limits-for-api-requests
- Payaca (UK CRM): https://payaca.com/feature/customer-relationship-management-crm ; Paya Connect (payments, name-collision): https://docs.payaconnect.com/developers/api
- Bridges: https://leadsbridge.com/blog/facebook-conversions-api/ ; https://help.gohighlevel.com/support/solutions/articles/48001233833-facebook-conversion-leads-walkthrough ; https://leadsbridge.com/conversions-sync/

## Key facts

- [VERIFIED] GoHighLevel runs API v2 exclusively on OAuth 2.0; v1 API keys deprecated (marketplace.gohighlevel.com/docs)
- [VERIFIED] GHL opportunity webhook payload includes monetaryValue, pipelineId, pipelineStageId, status, contactId — deal value IS in the payload (best case)
- [VERIFIED] GHL rate limits: 100 req/10s burst, 200,000 req/day per marketplace app per resource
- [VERIFIED] HubSpot supports deal.propertyChange and deal.stageChange webhook subscriptions, but the payload carries only objectId + propertyName + propertyValue — full deal must be fetched
- [VERIFIED] HubSpot: up to 1,000 webhook subscriptions per app; OAuth burst ~110 req/10s per account; auth via OAuth (multi-account) or Private App static token (single account)
- [VERIFIED] Attio offers OAuth 2.0 or workspace API key; deals is a core object with a currency-typed value attribute and a status-typed stage
- [VERIFIED] Attio record.updated webhook fires on attribute change but payload gives object_id/record_id/attribute_id + actor only — you must GET the record to read the new value
- [VERIFIED] Attio webhook rate limit ~25 requests/second per target URL
- [VERIFIED] Salesforce has NO native zero-config webhook; stage-change delivery uses Change Data Capture / Platform Events / Outbound Messages, all admin-configured in-org
- [VERIFIED] Salesforce CDC: 72-hour event retention, 5-entity selection cap without add-on, 2,000 concurrent subscribers; Opportunity uses StageName + Amount
- [VERIFIED] Monday is GraphQL; deals are board items, value/stage are per-board columns; board-level change_column_value webhook; complexity-budget rate limits (~10M/min/account)
- [VERIFIED] Pipedrive Webhooks v2 (default since Mar 2025) deliver the full deal object incl. value and stage_id, are free and don't consume tokens; custom fields are 40-char hashes
- [VERIFIED] Pipedrive token-based rate limits: 30,000 base tokens × plan multiplier × seats/day, 2-second burst window
- [VERIFIED] LeadsBridge already productises 'CRM pipeline-stage-change → Meta CAPI funnel event with stored FBCLID' — SOS's core mechanism is commoditised; the moat is value-weighting + attribution on top
- [INFERRED] The public docs.payaconnect.com ('Paya Connect', HMAC auth) is a US payments gateway, NOT Payaca the UK solar/trades CRM (payaca.com) — a name collision; Payaca UK's real API is not publicly documented
- [INFERRED] Deal value must be normalized as {amount, currency} across all providers because SOS's US expansion introduces USD alongside GBP
- [INFERRED] CRMs split into value-in-payload (GHL, Pipedrive) vs value-by-fetch (HubSpot, Attio, Monday, Salesforce) — the plugin needs a hydrate(crmId) method for the latter class
- [INFERRED] Stage mapping must be keyed on (pipelineId, stageId) not stageId alone, to survive multi-pipeline clients and stage renames
- [INFERRED] SOS runs webhook + poll hybrid per CRM (their own system log shows crm.poll AND POST /webhooks/crm), which the plugin should mirror as webhook-primary + reconciliation-poll safety net
- [INFERRED] A generic configurable adapter (define endpoints/auth/field-paths + transform→CanonicalFunnelEvent, structurally like Hogsend's defineWebhookSource) covers the 'bespoke if API available' long tail

## Open questions

- What is Payaca (UK, payaca.com) actual API surface? Does it expose contact/job/deal endpoints, outbound webhooks on job status, and job value in the payload? Public docs not found — requires direct contact or partner onboarding.
- Does Attio's record.updated payload include changed_attributes as a list, and can you scope a webhook subscription to only the deals 'value' and 'stage' attributes to avoid noisy fetch-storms?
- For HubSpot, is deal.stageChange a distinct subscription type or must you subscribe to deal.propertyChange on dealstage? And does the payload ever carry amount, or is a fetch always required?
- For Salesforce clients unwilling to enable CDC/Platform Events, what is the minimum-viable poll cadence on Opportunity LastModifiedDate that stays within per-org daily API limits at 54+ client scale?
- How does SOS actually stitch a FB click (no form fill) to a later organic form fill across sessions — cookie/localStorage UID, IP+fingerprint, or Perspective-side identity? This is the identity layer feeding the CRM push.
- Which attribution models does SOS actually run (they emphasise first-touch cross-session) and do they expose model choice per client, or is it a single blended model feeding CAPI value?
- Does Monday's change_column_value webhook reliably fire for status/dropdown columns used as deal stages, and how do you discover each client's value/stage column_ids at onboarding without manual config?
- GDPR/consent: what provenance fields does SOS legally need to retain independent of the CRM given the 29-day PII-deletion posture, and is a TrustedForm-style certificate needed for UK cold outreach or is submission-context sufficient?
