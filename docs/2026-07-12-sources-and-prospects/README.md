# Sources & Prospects — bringing CRM "ghost" contacts into lifecycle (and, later, outbound)

> Status: **in build** (feature branch `feat/sources-and-prospects`). This folder holds the design + the autonomous-loop execution plan for the feature.
>
> - [`execution-plan.md`](./execution-plan.md) — the phased, feature-by-feature build the autonomous loop drives.
> - [`consent-and-legal.md`](./consent-and-legal.md) — the fail-closed consent posture, why cold email is legal by default, and the "unflick" override.

## Why this exists

Everything Hogsend ships today assumes an **inbound** contact: an anonymous browser visitor who signs up and is stitched to an identity from the bottom up. But every primitive we already have — journeys, first-party tracking, preferences, connectors — works equally well for **outbound**: contacts *sourced* from a CRM / enrichment tool (Clay, Attio, HubSpot…) who are identified from day one but have given **no channel consent**.

The goal: let a sourced "ghost" contact join a lifecycle/outbound journey, be nurtured on the one channel that is legal cold (email), and **earn** warmer channels (SMS, voice, Discord/Telegram) by explicitly opting in. And to dogfood it — Hogsend using Hogsend to source its own customers.

This was scoped from a three-part investigation: a code-truth audit of the engine, plus deep research on Clay and Attio.

### What the audit found

- **The mental model holds.** An outbound contact is the *existing* contact model entered **top-down** (email-keyed on day one; the browser device attached later, on first cold-email click, via the `hs_t` identity token) instead of **bottom-up** (anon device → identified on signup). Both directions converge on one contact. This maps onto surfaces that already exist:

  ```
  defineWebhookSource → ingestEvent → resolveOrCreateContact → defineJourney (outbound)
                                                     ↑
                          browser stitched on first click (hs_t → /v1/t/identify) — already works
  ```

  **No new ingestion surface is required.**

- **Two assumptions from the original design thread were wrong in code** — and they are the real work:
  1. *"Fail-closed consent already covers cold — SMS/voice auto-block, only cold email flows."* **False today.** Email is opt-out (sends by default — which is legal for cold email), but connectors are *also* opt-out and the connector send gate **fails open**; SMS/voice don't exist on this branch at all. The protective posture is a **gap**, not a shipped feature — and it is legally load-bearing.
  2. *Phone as an identity key* — does not exist on this branch.

- **The build blocks are source-agnostic.** Clay has no public read API — outbound is an HTTP-column `POST` per row, async and retry-heavy (⇒ our endpoint must be idempotent). Attio has a real REST API, signed webhooks, and Automations with a first-class "Send HTTP Request" block, plus write-back via record upsert + notes. Everything else (HubSpot, Salesforce, Outreach, Zapier/Make/n8n) is covered on day one by a **generic webhook source**.

## Terminology (baked into code + docs)

| Term | Meaning |
|---|---|
| **Source** | An origin of contacts. Primitive: `defineContactSource()` — thin sugar over the existing `defineConnector` / `defineWebhookSource`. v1 adapters: `webhook` (generic), `clay`, `attio`. |
| **Sourcing event** | The normalized `IngestEvent` a source emits: `userEmail` (anchor key) + `contactProperties` (enrichment) + sourcing context (`source`, list, `sourcedAt`). Feeds the existing `ingestEvent()`. |
| **Prospect** | A contact with `source` set and **no channel consent** (cold). *Not* a new table — just a contact whose provenance is `sourced`. Distinct in UI/segments from an engaged **Contact**. |
| **Consent posture** | Per-channel opt-in state. Legal-safe default: cold **email** allowed (opt-out + identification + unsubscribe, already done by the mailer); SMS/voice/connectors **fail-closed** until explicit opt-in. |
| **Write-back** | Pushing journey/engagement status back to the source CRM (Attio first). |

## Building blocks & the surfaces they reuse

| Block | New? | Reuses |
|---|---|---|
| `defineContactSource()` | thin new sugar | `defineConnector` / `defineWebhookSource` (`packages/engine/src/webhook-sources/define-webhook-source.ts`), served on the existing `POST /v1/webhooks/:sourceId` route |
| Sourcing event → contact | reuse | `ingestEvent()` (`packages/engine/src/lib/ingestion.ts`), `resolveOrCreateContact` + `contactProperties` merge (`packages/engine/src/lib/contacts.ts`) |
| Provenance stamp | new columns | `contacts` (`packages/db/src/schema/contacts.ts`) — mirror how `discordId` was added |
| Cold consent posture | surgical flips | `ListRegistry.isSubscribed` already does fail-closed for `defaultOptIn:false` (`packages/engine/src/lists/registry.ts`); `synthesizeChannelLists` (`packages/engine/src/lists/channels.ts`); the gate `checkActionAudience` (`packages/engine/src/lib/connector-actions.ts`) |
| Browser stitch on click | **already works** | `hs_t` token + `POST /v1/t/identify` (`routes/tracking/click-pipeline.ts`, `routes/tracking/identify.ts`) — verified, no work |
| Outbound journey | reuse | `defineJourney` (`packages/engine/src/journeys/define-journey.ts`) |
| Write-back adapter | new | Attio REST (`PUT /v2/objects/people/records`, `POST /v2/notes`) |

## The source ecosystem (why these three for v1)

- **Tier 1 — build native now:** **Clay** (enrichment → HTTP column → webhook) and **Attio** (CRM source-of-truth → automation/webhook in, REST upsert + notes out). The modern GTM stack.
- **Tier 0 — nearly free, covers everything else today:** a **generic webhook source**. Because it all funnels through `defineWebhookSource → ingestEvent`, anything that can POST — HubSpot workflows, Salesforce flows, Outreach, Zapier/Make/n8n — becomes a source with zero bespoke code.
- **Tier 2 — native later:** HubSpot (huge install base; full OAuth-app + marketplace lift).
- **Tier 3:** Salesforce (enterprise; heavy OAuth + object model).
- **Not sources — competitors:** Outreach / Salesloft / Instantly / Smartlead are senders/sequencers occupying the exact seat Hogsend does. We *replace* them in the Clay handoff; we don't integrate them.

## The canonical loop this enables

```
Clay enriches → upserts Attio → Attio automation fires on "qualified"
   → POST our ingest → Prospect upserted (cold, email-only)
   → outbound journey: cold email → engagement → opt-in unlocks warmer channels
   → write status/notes back to Attio
```
