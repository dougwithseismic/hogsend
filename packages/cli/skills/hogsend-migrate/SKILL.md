---
name: hogsend-migrate
description: Use when migrating a product OFF Loops, Customer.io, or Resend Broadcasts/Audiences onto Hogsend — auditing the existing email-SaaS integration (SDK calls in code + GUI-side workflows/campaigns/segments/templates), mapping each source concept to its Hogsend equivalent (contacts.upsert, events.send, defineJourney journeys, four-file react-email templates, defineList lists, buckets, campaigns, webhook sources), then executing an incremental dual-write → verify → switch → remove cutover that preserves unsubscribes/suppression. NOT for a greenfield integration with no incumbent (that is hogsend-integrate) and NOT for authoring mechanics themselves (delegate to the hogsend-authoring-* skills).
license: MIT
metadata:
  author: withSeismic
  version: "1.0.0"
---

# Migrate to Hogsend (from Loops / Customer.io / Resend Broadcasts)

A migration has two halves: the **code half** (SDK calls you can grep) and the
**GUI half** (workflows, campaigns, segments, templates that live only in the
source platform's dashboard). This skill audits both, maps every source concept
to its Hogsend equivalent, and runs an incremental cutover — never a big-bang
switch.

Two codebases are in play. The **host product** keeps (rewired) SDK calls — work
there follows the **hogsend-integrate** patterns. The **Hogsend app** (a
scaffolded `create-hogsend` project) is where journeys, templates, and lists are
authored — mechanics delegate to the **hogsend-authoring-\*** skills.

## Non-negotiable safety rules (read before anything else)

1. **Import unsubscribes BEFORE any Hogsend send.** A migration that emails one
   unsubscribed person is a failed migration (and a legal problem). Export the
   source platform's suppression/unsubscribe list first and apply it (cutover
   reference shows how). Never bulk-unsubscribe everyone "to be safe" either —
   polarity matters.
2. **Dual-write before switching.** Old and new pipelines run side by side
   until verified. Hogsend writes are idempotent-friendly (`idempotencyKey`),
   so dual-writing is cheap.
3. **One sender of each email at a time.** When a Hogsend journey goes live,
   pause the corresponding source-platform workflow in the same change window —
   duplicated sends erode trust faster than missed ones.

## Step 1 — audit what exists

**Code half** — grep the host product (full per-platform greps + before/after
snippets in the matching reference):

| Platform | Grep for |
|---|---|
| Loops | `loops` dep (`loops` / `@loops/*`), `sendEvent`, `updateContact`, `sendTransactionalEmail`, `transactionalId` |
| Customer.io | `customerio-node` dep, `cio.identify`, `cio.track`, `trackAnonymous`, `triggerBroadcast`, in-app `_cio` snippet |
| Resend Broadcasts | `resend.broadcasts.`, `resend.audiences.`, `resend.contacts.` — DISTINCT from plain `resend.emails.send` (transactional, may stay) |

**GUI half** — not in the codebase; ask the user to export or screenshot from
the source dashboard:

- workflows/campaigns (triggers, delays, branches, exit rules)
- segments/audiences (definitions, member counts)
- templates (HTML/content + which are transactional vs marketing)
- the suppression/unsubscribe list (CRITICAL — rule 1)
- API keys' event names actually flowing (last 30 days), to scope the event
  vocabulary

Output of this step: an inventory table (source asset → type → destination in
Hogsend → owner) the user signs off on.

## Step 2 — map concepts (per-platform tables)

The shared shape — almost everything lands in one of seven Hogsend concepts:

| Source concept (any platform) | Hogsend equivalent |
|---|---|
| Contact / person / audience member | contact — `hs.contacts.upsert` (`@hogsend/client`) |
| Event / track call | `hs.events.send` (`eventProperties` vs `contactProperties` split) |
| Workflow / loop / campaign-with-delays | journey — `defineJourney()` in the Hogsend app's `src/journeys/` |
| Transactional email | `hs.emails.send` + a four-file react-email template in `src/emails/` |
| Mailing list / audience / topic | list — `defineList()` (polarity via `defaultOptIn`) |
| Behavioral segment | bucket — `defineBucket()` (criteria-driven, real-time) |
| One-off broadcast/newsletter | campaign — `hs.campaigns.send` / `hogsend campaigns send` (targets a list or bucket) |

Platform-specific tables, audit greps, and rewrite examples:

- **Loops** → `references/loops-mapping.md`
- **Customer.io** → `references/customerio-mapping.md`
- **Resend Broadcasts/Audiences** → `references/resend-broadcasts-mapping.md`
  (special case: Resend can REMAIN the delivery wire — Hogsend's default
  `EmailProvider` is Resend, so this migration replaces the orchestration
  layer, not necessarily the sending infrastructure)

## Step 3 — generate the Hogsend setup

Work in the Hogsend app, one source asset at a time. This skill decides WHAT to
build; the authoring skills own HOW:

- **Each workflow/campaign-with-logic → a `defineJourney()`** in
  `src/journeys/`. Translate: entry trigger → `trigger: { event, where? }`;
  re-entry rules → `entryLimit: "once" | "once_per_period" | "unlimited"`;
  goal/exit rules → `exitOn`; delays → `await ctx.sleep({ duration: days(n) })`;
  branches → plain TypeScript `if` on `ctx.history.hasEvent(...)`. Mechanics +
  registration ritual → **hogsend-authoring-journeys**; condition syntax →
  **hogsend-conditions**.
- **Each template → the four-file contract** (`src/emails/<name>.tsx` +
  `types.ts` props + `registry.ts` entry + `templates.d.ts` augmentation).
  Port content into react-email components; subjects/preview/category live on
  the registry entry. → **hogsend-authoring-emails**.
- **Each list/audience/topic → `defineList({ id, name, defaultOptIn })`** in
  `src/lists/`. Get `defaultOptIn` right: a newsletter people subscribed to is
  opt-in (`defaultOptIn: false`); product/account notices are typically opt-out
  (`defaultOptIn: true`). → **hogsend-authoring-lists**.
- **Each behavioral segment → a bucket** (criteria tree over events/properties)
  when it gates journeys or campaigns. → **hogsend-authoring-buckets**.
- **Inbound webhooks worth keeping** (the source platform was receiving
  provider webhooks that should now hit Hogsend) → `defineWebhookSource()` or
  the built-in Clerk/Supabase/Stripe/Segment presets. →
  **hogsend-webhooks-and-workflows**.
- **Outbound syncs** (source platform pushed data to other tools) → webhook
  endpoints / keyed destinations (`hs.webhooks.create` with `kind`). →
  **hogsend-authoring-destinations**.

Then rewire the host product's SDK calls to `@hogsend/client` equivalents
(per-platform before/after in the references; client patterns in
**hogsend-client-sdk** / **hogsend-integrate**).

## Step 4 — incremental cutover (dual-write → verify → switch → remove)

The full checklist with commands is `references/cutover-checklist.md`. The
stages:

1. **Dual-write.** Import contacts + suppression state (suppression FIRST).
   Add Hogsend calls BESIDE the existing SDK calls — same handlers, both fire.
   Journeys are authored but disabled (`enabled: false` or left out of
   `ENABLED_JOURNEYS`). Nothing user-visible changes.
2. **Verify.** Compare event volume between platforms over a few days
   (`hogsend stats --json`, `hogsend events <userId> --json` spot checks).
   Enable each journey for a seed/test contact, walk the full flow, diff
   rendered templates against the originals (`hogsend emails send <template>
   --to you@…`).
3. **Switch.** Per flow: enable the Hogsend journey
   (`hogsend journeys enable <id>` or `ENABLED_JOURNEYS`) and pause the source
   workflow in the same window. Flip transactional sends to `hs.emails.send`.
   Run broadcasts as Hogsend campaigns.
4. **Remove.** After a clean soak (1-2 send cycles), delete the old SDK calls,
   uninstall the dep, revoke the old API keys, export a final archive from the
   source platform, then close the account.

## Task playbooks — load the matching reference

- **Migrating from Loops** → `references/loops-mapping.md`
- **Migrating from Customer.io** → `references/customerio-mapping.md`
- **Migrating from Resend Broadcasts/Audiences** →
  `references/resend-broadcasts-mapping.md`
- **Executing the cutover (imports, verification commands, switch order,
  rollback)** → `references/cutover-checklist.md`
