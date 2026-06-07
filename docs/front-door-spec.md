# Hogsend Front Door — public data API + `@hogsend/client` SDK

**Status:** ✅ SIGNED OFF (D1–D6 accepted) · **Goal:** Loops.so-parity developer front door; code-first journeys kept as the moat · **Audience:** us

> **Implementation source of truth:** `docs/front-door-build-plan.md` (locked interface contract, conflict-free file ownership, 14-stage execution plan, destructive-cleanup list). This spec is the rationale/narrative; the build plan is what the code is built from.
> **Refinements accepted at sign-off:** (a) identity supports future **anonymous→identified** via an `anonymous_id` key + a real merge/alias resolver (not just fill-in); (b) store **normalized raw email** (required to send) — `email_hash` for suppression-after-erasure deferred; (c) **destructive latitude** — the old `/v1/ingest` shape and redundant paths are deleted, not deprecated (no back-compat shims).

> This is the end-to-end spec. Everything needed to sign off and start work is here: data-model changes (§3), the public API (§4), the email-tracking reality we inherit (§5), the client SDK + existing ecosystem (§6), build flows (§7), the win/keep/reframe map (§11), the itemized per-package work breakdown (§13), migrations (§14), acceptance criteria (§15), phasing (§16), and a sign-off checklist (§17).

---

## 0. TL;DR

Loops leads with a tiny SDK over **contacts / events / transactional**; the journey logic hides in a GUI. Hogsend leads with `defineJourney()` (real durable journeys) but has **no public front door** — the data surface is buried behind `/v1/admin/*` session/admin auth or doesn't exist, and there's no programmatic client.

This spec adds the front door:

1. A **public data-plane HTTP API** (`/v1/contacts`, `/v1/events`, `/v1/emails`, `/v1/lists`), API-key authed with a new `ingest` scope.
2. A typed **`@hogsend/client`** package (Loops-style: `hs.contacts.upsert`, `hs.events.send`, `hs.emails.send`) for app code — distinct from the existing observe-only `@hogsend/cli`.
3. Data-model sharpening: email-or-userId identity, a clean `contactProperties` vs `eventProperties` split, code-defined lists.

Differentiators kept: code journeys, buckets, **first-party tracking incl. transactional** (already built — §5), React typed templates, `create-hogsend`, self-host/own-your-data.

**The reframe:** we are *not* rebuilding the contact store to "escape PostHog." `contacts.properties` is already the authoritative local store; PostHog is already optional (one best-effort read, for timezone, with fallbacks). The work is **exposing and sharpening what we own**, not migrating off PostHog.

---

## 1. What's already true (so we don't over-build)

| Capability | Status today | Implication |
|---|---|---|
| Authoritative local contact store | ✅ `contacts.properties` JSONB merged on upsert (`lib/contacts.ts`) | Expose & sharpen, don't rebuild |
| API-key auth | ✅ `api_keys` + `requireApiKey`/`requireScope` (Bearer, hashed, 60s cache, `ADMIN_API_KEY` legacy) | Add one `ingest` scope, reuse the rest |
| Event pipeline | ✅ `ingestEvent()` stores event → pushes Hatchet → checks exits → upserts contact → re-evals buckets | Split contact-write from event-write |
| **Email link/open tracking** | ✅ `prepareTrackedHtml` (rewrite links + open pixel) + `/v1/t/c/:id` + `/v1/t/o/:id`, re-ingests events | **Front door inherits it for free** (§5) |
| Send pipeline | ✅ `createTrackedMailer.send()` works journeyless (raw/transactional) | Public `/v1/emails` is a thin wrapper |
| Subscription state | ✅ `email_preferences.categories` JSONB + unsubscribe tokens + preference center | Promote `categories` → named lists |
| Deliverability signals | ✅ Resend webhook → `email_sends` status (sent/delivered/opened/clicked/bounced/complained), bounce classification, frequency cap | Reuse as-is |
| Operator CLI | ✅ `@hogsend/cli` (`hogsend` bin): `contacts`/`events`/`journeys`/`stats` — **read-only, admin-key, observe** | Add write commands using the data plane (§6) |
| Scaffolder | ✅ `create-hogsend` → journeys + buckets + emails + worker + migrations | Add client + API-key wiring (§12) |
| PostHog coupling | ✅ Optional: only tz resolution reads it (`define-journey.ts:148`, `posthog?.`, has fallbacks) | Keep as optional enrichment/mirror |
| Hogsend→PostHog mirror | ✅ Opt-in `bucket-posthog-sync.ts` (`$set`/`$unset`) | "Sync target not source" already ships |
| Multi-tenancy | ⚠️ Latent: `organizationId` on `contacts`/`api_keys`/`email_sends`, unused | Per-org data-plane scoping later |

**Gaps the front door fills:** (a) `/v1/ingest` is **unauthenticated** (no middleware on its router); (b) identity is **externalId-only** (`upsertContact` conflict target is `externalId`); (c) `ingestEvent` **merges every event's `properties` into the contact** (conflation); (d) no public **contacts/transactional/lists** API; (e) no **programmatic client**.

---

## 2. Decisions to confirm

> Recommendations below; flag any to change before code. D1 is the only schema-level fork.

**D1 — Identity → "canonical id + resolvable keys".** Internal `contacts.id` stays canonical. Both `email` and `externalId` become resolvable keys; the API accepts `{ userId }`, `{ email }`, or both. Requires `externalId` → **nullable**, a unique partial index on `email`, and `resolveOrCreateContact()`. Two keys pointing at two rows → **fill-in for phase 1, true merge deferred** (logged). _Alt rejected:_ synthesize externalId from email (clunky).

**D2 — `contactProperties` vs `eventProperties` → split.** Only an explicit `contactProperties` bag writes to `contacts.properties`; `eventProperties` live on `user_events`. **Behavior change** to `ingestEvent`. `trigger.where` → `eventProperties`; bucket criteria → `contacts.properties`. Call out in release notes.

**D3 — Lists → code-defined over the existing categories store.** `defineList({ id, name, defaultOptIn })`; membership in `email_preferences.categories`. Reuses unsubscribe tokens + preference center. No new tables in phase 1.

**D4 — PostHog → optional enrichment + opt-in mirror, never required.** No hard read dependency. Keep the anti-CDP invariant (mirror to PostHog only).

**D5 — Data-plane scope → new `ingest` scope.** For the front-door key (contacts/events/emails/lists write), orthogonal to admin tiers; `full-admin` implies it. Apply `requireApiKey` to new routes and **retrofit the open `/v1/ingest`**.

**D6 — Package naming → `@hogsend/client` (canonical), optional unscoped `hogsend` alias.** The SDK is `@hogsend/client` (guaranteed publishable, consistent scope). If the unscoped `hogsend` name is obtainable, publish it as a thin re-export so `npm i hogsend` works (Loops-style). The `hogsend` *binary* stays owned by `@hogsend/cli` — package name ≠ bin name, no collision. _Note:_ first publish of `@hogsend/client` is **manual** (CI can't create new `@hogsend/*` packages — see release skill).

**Deferred:** Loops-compat shim (`createContact`/`sendEvent` drop-in) — good idea, revisit post-Phase-2 as a migration wedge.

---

## 3. Data-model changes

### 3.1 Identity (D1)

```ts
// packages/db/src/schema/contacts.ts
externalId: text("external_id").unique(),        // was .notNull().unique()
// + unique partial index on lower(email) WHERE email IS NOT NULL AND deleted_at IS NULL
```

```ts
// packages/engine/src/lib/contacts.ts — new resolver, used by the event path + public routes
export async function resolveOrCreateContact(opts: {
  db: Database; userId?: string; email?: string;
  contactProperties?: Record<string, unknown>;
}): Promise<{ id: string; created: boolean; linked: boolean }> {
  // 1. lookup by externalId (if userId) else by email
  // 2. not found → insert (externalId|email|both)
  // 3. found, other key missing → fill it in (link)
  // 4. found by both keys but they disagree → phase-1: keep externalId row, log "alias-needed"
  // 5. merge contactProperties via COALESCE(properties,'{}') || patch
}
```

`upsertContact()` delegates to `resolveOrCreateContact` (replaces the conflict-on-`externalId` upsert so email-only contacts work).

### 3.2 Property split (D2)

```ts
// packages/engine/src/lib/ingestion.ts
export interface IngestEvent {
  event: string;
  userId?: string;                               // now optional (email-only)
  userEmail?: string;
  eventProperties: Record<string, unknown>;      // → user_events + Hatchet trigger.where
  contactProperties?: Record<string, unknown>;   // → contacts.properties ONLY
  idempotencyKey?: string;
}
```

`ingestEvent` writes `eventProperties` to `user_events` + Hatchet, merges **only `contactProperties`** into the contact, then re-evals buckets against the updated contact state. (Today's line 84–88 `properties: event.properties` becomes `contactProperties`.)

### 3.3 Lists (D3)

```ts
// new: packages/engine/src/lists/define-list.ts (consumer authors in src/lists/)
export const productUpdates = defineList({ id: "product-updates", name: "Product updates", defaultOptIn: false });
```
Membership = `email_preferences.categories["product-updates"] === true`. `GET /v1/lists` reads the registry; subscribe/unsubscribe flip the JSONB key via the existing preference path.

### 3.4 API-key scope (D5)

```ts
// packages/engine/src/middleware/api-key.ts
// data-plane: "ingest" (contacts/events/emails/lists write)
// admin tiers (existing): "read" < "journey-admin" < "full-admin"; full-admin implies ingest.
// Data-plane routes: requireApiKey + requireScope("ingest").
```

---

## 4. Public HTTP API (data plane)

Base `/v1`, `Authorization: Bearer <key>` (scope `ingest`). Optional `Idempotency-Key` header. Shapes mirror Loops so migration is a search-replace.

### 4.1 Contacts
```http
PUT    /v1/contacts                       # upsert by email OR userId
GET    /v1/contacts/find?email=… | ?userId=…   # → Contact[]
DELETE /v1/contacts   { email | userId }  # soft delete
```
```jsonc
// PUT /v1/contacts
{ "email": "a@b.com", "userId": "user_123",
  "properties": { "plan": "pro", "company": "Acme" },
  "lists": { "product-updates": true } }
// → 200 { "id": "…", "created": false, "linked": true }
```

### 4.2 Events (the journey trigger)
```http
POST /v1/events
```
```jsonc
{ "name": "signup", "email": "a@b.com", "userId": "user_123",
  "eventProperties": { "source": "web" },     // event-only
  "contactProperties": { "plan": "pro" },      // → contact (D2)
  "lists": { "product-updates": true } }
// → 202 { "stored": true, "exits": [ … ] }
```

### 4.3 Transactional / one-off email
```http
POST /v1/emails
```
```jsonc
{ "to": "a@b.com",                    // or { "userId": "user_123" }
  "template": "welcome",              // registry key = Loops transactionalId, but type-checked
  "props": { "firstName": "Bob" },    // = Loops dataVariables
  "idempotencyKey": "…" }
// → 202 { "emailSendId": "…", "status": "queued" }
```
Backed by `EmailService.send()` → **full tracking pipeline (§5) runs automatically**. `skipPreferenceCheck` requires `full-admin`. Default `from`/`subject` from the template registry.

### 4.4 Lists
```http
GET  /v1/lists                                  # → [{ id, name, defaultOptIn }]
POST /v1/lists/:id/subscribe    { email | userId }
POST /v1/lists/:id/unsubscribe  { email | userId }
```

---

## 5. Email tracking & deliverability (already built — the front door inherits it)

> Directly answering "is our Hono server capable of taking tracking links parsed from the React email templates?" — **yes, end to end.** Documented here so it's part of the signed-off surface; the only front-door work is making sure public sends flow through it (they do).

### 5.1 The send → track pipeline
1. **Render.** A React Email template (`src/emails/*.tsx`) is rendered to an HTML string by `renderToHtml(element)` (`@hogsend/email` → `@react-email/render`).
2. **Insert send row.** `email_sends` row created (`queued`), with denormalized `userId`/`userEmail`/`templateKey`/`category` (journeyless sends supported — `journeyStateId` nullable).
3. **Rewrite links** (`lib/tracking.ts` `rewriteLinks`). Regex `href="(https?://…)"` over the rendered HTML; collect unique absolute URLs; **skip** `/v1/email/unsubscribe` + `/v1/email/preferences`; bulk-insert one `tracked_links` row per unique URL; single-pass replace each `href` → `${API_PUBLIC_URL}/v1/t/c/${trackedLinkId}`.
4. **Inject open pixel** (`injectOpenPixel`). `<img src="${API_PUBLIC_URL}/v1/t/o/${emailSendId}" width=1 height=1 style="display:none">` before `</body>`.
5. **Send.** Tracked HTML handed to the provider (`createResendProvider.send`). Unsubscribe headers (`List-Unsubscribe`, `…-Post: One-Click`) added.

### 5.2 The collection endpoints (Hono)
- `GET /v1/t/c/:id` (`id` = tracked-link uuid) → lookup; missing → 302 to `API_PUBLIC_URL`; record `link_clicks` (IP from `x-forwarded-for[0]`/`x-real-ip`, user-agent), `clickCount++`, set `email_sends.clickedAt` **first click only** (`WHERE clickedAt IS NULL`), **302 → original URL**, then fire-and-forget `pushTrackingEvent("email.link_clicked", { linkUrl, linkId })`.
- `GET /v1/t/o/:id` (`id` = email-send uuid) → set `email_sends.openedAt` **first open only**, return a 1×1 transparent GIF (`no-store`), then fire-and-forget `pushTrackingEvent("email.opened")`.

### 5.3 Events loop back into the engine
`pushTrackingEvent` → `resolveEmailSendContext` (LEFT JOIN `email_sends`→`journey_states` for `userId`/`userEmail`/`templateKey`, falling back to `toEmail`) → **PostHog capture + `ingestEvent`**. So an open/click is a first-class event that can **trigger journeys and move bucket membership** (e.g. "clicked but didn't convert" buckets). This is a capability Loops does not expose for transactional mail.

### 5.4 Two signal sources, by design
- **First-party** (pixel + redirect) — durable, ours, covers transactional, drives the engine.
- **Provider** (Resend webhook → `mailer.handleWebhook` → `email_sends` status map) — `sent/delivered/opened/clicked/bounced/complained` + bounce classification → feeds suppression + frequency cap.

### 5.5 Tables
`tracked_links` (id, emailSendId FK cascade, originalUrl, clickCount) · `link_clicks` (id, trackedLinkId FK, ipAddress, userAgent, clickedAt) · `email_sends` (rich: status timestamps, bounceType/Reason, frequency-cap index, denormalized identity).

### 5.6 Known boundaries (document, not bugs)
- Link rewriting matches **double-quoted absolute `https?://` hrefs** only. React Email's `render()` emits exactly this, so all `<Link>`/`<a href>` links are tracked. Relative URLs, single-quoted hrefs, and non-`href` URLs (e.g. CSS backgrounds) are **not** tracked — intentional.
- Opens depend on image loading (clients that block images undercount) — standard for pixel tracking; clicks are the reliable signal.
- **Front-door additions to tracking: none structural.** Public `/v1/emails` sends inherit everything because they use the same mailer. Optional later: read endpoints already exist in admin (`/v1/admin/emails`, `/v1/admin/metrics`) — could be surfaced to the data plane if devs want programmatic tracking reads.

---

## 6. The client SDK + the existing ecosystem

Three published surfaces, clearly separated:

| Surface | Package | Auth | Role |
|---|---|---|---|
| **Programmatic client** (NEW) | `@hogsend/client` (+ optional `hogsend` alias) | data-plane key (`ingest`) | App code writes contacts/events/emails — the Loops front door |
| **Operator CLI** (exists) | `@hogsend/cli` → `hogsend` bin | admin key (`read`+) | Observe/ops: `contacts list/get/timeline`, `events`, `journeys`, `stats`, `doctor`, `studio` |
| **Engine + scaffold** (exists) | `@hogsend/engine`, `create-hogsend` | n/a | The durable back end + first-run |

This is a first-run story Loops can't match: `pnpm dlx create-hogsend` gives you the engine **and** the client wiring **and** an operator CLI, all typed, all yours.

### 6.1 `@hogsend/client` surface
```ts
import { Hogsend } from "@hogsend/client";
const hs = new Hogsend({ baseUrl: "https://your-hogsend.app", apiKey: process.env.HOGSEND_API_KEY! });

// Contacts (upsert-first, email OR userId)
await hs.contacts.upsert({ email: "a@b.com", properties: { plan: "pro" } });
await hs.contacts.find({ email: "a@b.com" });        // → Contact[]
await hs.contacts.delete({ userId: "user_123" });

// Events (props split)
await hs.events.send({
  name: "signup", email: "a@b.com",
  contactProperties: { plan: "pro" },
  eventProperties: { source: "web" },
  idempotencyKey: crypto.randomUUID(),
});

// Transactional (typed against the app's template registry)
await hs.emails.send({ to: "a@b.com", template: "welcome", props: { firstName: "Bob" } });

// Lists
await hs.lists.subscribe({ list: "product-updates", email: "a@b.com" });
```
**Error model** mirrors Loops: `HogsendAPIError` (`status`, `body`), `RateLimitError extends HogsendAPIError` (`retryAfter`). The fetch/parse/error core is lifted from the proven `@hogsend/cli` `lib/http.ts` and shared.

**Typed templates.** `template`/`props` are typed against the consumer's `TemplateRegistryMap` augmentation (re-exported), giving autocomplete + prop-checking — a concrete win over Loops' untyped `dataVariables`.

### 6.2 New CLI write commands (small, high-DX)
The CLI is observe-only today. Add **write** subcommands that use the data plane (a `--data-key` or reused config), so you can drive journeys from the terminal while building:
```bash
hogsend events send signup --email a@b.com --set plan=pro --prop source=web
hogsend contacts upsert --email a@b.com --set plan=pro
hogsend emails send welcome --to a@b.com --prop firstName=Bob
```
These wrap §4 exactly and make local journey testing a one-liner.

---

## 7. End-to-end: what it looks like to build

### 7.1 A SaaS wiring Hogsend from scratch
```ts
// 1. pnpm dlx create-hogsend@latest my-lifecycle
//    → scaffolds engine + journeys + emails; prints HOGSEND_API_KEY; deploys

// 2. product app, on signup:
import { hs } from "./lib/hogsend";                 // scaffolded client instance
await hs.contacts.upsert({ userId: user.id, email: user.email, properties: { plan: "free" } });
await hs.events.send({ name: "user.signed_up", userId: user.id, email: user.email });

// 3. the scaffolded journey already listens:
//    defineJourney({ meta: { trigger: { event: "user.signed_up" } }, run: async (u, ctx) => {
//      await sendEmail({ to: u.email, template: "welcome", … });   // tracked (§5) automatically
//      await ctx.sleep({ duration: days(2) });
//      if (!(await ctx.history.hasEvent({ userId: u.id, event: "feature.used" })).found) { … }
//    }})

// 4. fire a receipt directly (tracked, type-checked):
await hs.emails.send({ to: user.email, template: "receipt", props: { amount: 4900 } });
```
The dev touches the **client** (Loops-like). The **journey logic lives in their repo as code** (the moat). Buckets segment automatically as `contactProperties` change. Opens/clicks feed back as events (§5.3).

### 7.2 Auth provider → contact (the "deep integration")
```
Clerk/Supabase webhook → POST /v1/webhooks/clerk (defineWebhookSource preset)
  → transform(user.created) → resolveOrCreateContact({ userId, email, contactProperties })
  → ingestEvent("user.created") → journey fires
```
Identical to how Loops' "native" integrations work (they're webhook wrappers) — but ours is a code-defined, inspectable `defineWebhookSource`.

---

## 8. PostHog, redefined (D4)

| Direction | Before | After |
|---|---|---|
| Contact props (read) | local JSONB authoritative; PostHog read once for tz (optional, fallback) | unchanged — local authoritative; tz read stays optional |
| Inbound | PostHog webhook source → events | one optional source among many (Clerk/Supabase/Stripe/Segment join it) |
| Outbound | opt-in bucket mirror (`$set`/`$unset`) | keep; PostHog is a **mirror**, not the store; anti-CDP invariant holds |

Net: **no hard PostHog dependency anywhere.** Self-host without `POSTHOG_API_KEY` and everything works. "Hold it independently" — already mostly realized, now explicit.

---

## 9. Integrations as webhook-source presets (Phase 2)

Loops' "deep" integrations = opinionated webhook wrappers; we already have `defineWebhookSource`. Ship presets (consumers enable by env):
- **Clerk** — `user.created/updated/deleted`, `waitlistEntry.*`
- **Supabase** — `auth.users` INSERT/UPDATE/DELETE
- **Stripe** — `customer.*`, `invoice.*`, `subscription.*`
- **Segment / RudderStack** — `identify`/`track` → `contacts.upsert`/`events.send` 1:1

Each ~30 lines of `transform()`. High marketing value, low cost.

---

## 10. Outbound webhooks (Phase 3)

Svix-style signed outbound catalog so others build on Hogsend like they build on Loops: `contact.created/updated/deleted/unsubscribed`, `email.sent/delivered/opened/clicked/bounced`, `journey.completed`, `bucket.entered/left`. New `webhook_endpoints` table; HMAC-SHA256 (`Webhook-Signature`/`-Id`/`-Timestamp`); delivery via a Hatchet task with retries.

---

## 11. Where the existing work fits — win / keep / reframe

> Direct answer to "I really like our work — is it a win? where does the rest fit?"

| Existing piece | Verdict | Role in the front-door world |
|---|---|---|
| **Buckets** (segments, dwell, `.on enter/leave/dwell`) | **WIN — flagship** | Our audiences/segments; better than Loops' filter dropdowns. Expose read via API. Criteria eval authoritative contact state. |
| **defineJourney / journeys** | **WIN — the moat** | The differentiator vs Loops' shallow builder. Triggered by the unified pipeline. Largely unchanged. |
| **Email tracking (links + opens, incl. transactional)** | **WIN — already ahead** | §5. Public `/v1/emails` inherits it; opens/clicks loop back as events. |
| **React email registry + typed props** | **WIN, reframed** | The transactional template catalog; `template` key = Loops `transactionalId`, but type-checked through the SDK. |
| **createTrackedMailer / sendEmail** | **KEEP** | Backs `/v1/emails`. Journeyless path already exists. No change. |
| **ingestEvent** | **REFRAME** | Split `contactProperties`→contact, `eventProperties`→event (D2). |
| **contacts + upsertContact** | **EXTEND** | externalId nullable, email as alt key, `resolveOrCreateContact` (D1). The authoritative store. |
| **email_preferences.categories** | **REFRAME** | Backing store for first-class lists (D3). Tokens/preference center reused. |
| **`@hogsend/cli` (hogsend bin)** | **KEEP + EXTEND** | Stays the observe/ops tool; gains write commands on the data plane (§6.2). `lib/http.ts` core shared into `@hogsend/client`. |
| **Admin routes** (CRUD/journeys/metrics/suppressions/bulk) | **KEEP — ops plane** | Studio/CLI surface (admin auth). Shares the contact core with the public data plane. |
| **api_keys + requireApiKey/requireScope** | **EXTEND** | Add `ingest` scope; apply to public routes; close open `/v1/ingest` (D5). |
| **plugin-posthog** | **REFRAME — optional** | Enrichment source + opt-in mirror, never required (D4). |
| **bucket-posthog-sync** | **WIN** | Proof the "PostHog as sync target" model already works. |
| **defineWebhookSource** | **WIN — integration primitive** | Ship Clerk/Supabase/Stripe/Segment presets (§9). |
| **Studio** | **WIN** | Observes a richer, authoritative contact store; "observe not author" intact. |
| **create-hogsend** | **WIN — DX edge** | Now also scaffolds the client + an API key (§12). Loops can't hand you "npx and you're wired end-to-end." |
| **Outbound webhooks** | **NEW** | §10, Phase 3. |

Nothing of value is discarded. The journey/bucket/tracking engine is the differentiated back end; the front door is what we were missing.

---

## 12. `create-hogsend` & first-run after the front door

Scaffold gains: (1) generate a first **data-plane API key** on bootstrap and print it; (2) scaffold `src/lib/hogsend.ts` (a configured `Hogsend` client → local engine); (3) a `src/lists/` dir with one example `defineList`; (4) README "integrate from your app" snippet using `hs.events.send`. Result: a fresh scaffold ships **both ends** — engine + client + operator CLI.

---

## 13. Work breakdown / change manifest (per package)

> Phase 1 unless tagged. Each line is a discrete, reviewable change.

**`packages/db`**
- [ ] `contacts.externalId` → nullable; add unique partial index on `lower(email)` where not null & not deleted. *(D1, migration)*
- [ ] (Phase 3) `webhook_endpoints` table.

**`packages/engine` — data model & ingestion**
- [ ] `lib/contacts.ts`: add `resolveOrCreateContact()`; rewrite `upsertContact()` to use it.
- [ ] `lib/ingestion.ts`: `IngestEvent` gains `eventProperties` + `contactProperties`; `userId` optional; merge only `contactProperties` into the contact; pass `eventProperties` to `user_events`/Hatchet. *(D2 — behavior change)*

**`packages/engine` — auth**
- [ ] `middleware/api-key.ts`: add `ingest` scope (orthogonal; `full-admin` implies). `requireScope("ingest")` for data-plane.
- [ ] Apply `requireApiKey` + `requireScope("ingest")` to `/v1/ingest` (close the open route) and all new data-plane routes. *(D5 — security fix)*

**`packages/engine` — public routes (new)**
- [ ] `routes/contacts/` → `PUT /v1/contacts`, `GET /v1/contacts/find`, `DELETE /v1/contacts` (Zod schemas, `.openapi()`).
- [ ] `routes/events/` → `POST /v1/events` (the new shape; wraps `ingestEvent`).
- [ ] `routes/emails/` → `POST /v1/emails` (wraps `EmailService.send`; preference checks on; `skipPreferenceCheck` gated to `full-admin`).
- [ ] `routes/lists/` → `GET /v1/lists`, `POST /v1/lists/:id/(un)subscribe`.
- [ ] Register all in `routes/index.ts`.

**`packages/engine` — lists (new)**
- [ ] `lists/define-list.ts` + `ListRegistry`; wire into `createHogsendClient` options (`lists?`) and container. *(D3)*

**`packages/client` (NEW package → `@hogsend/client`)**
- [ ] `Hogsend` class: `contacts.{upsert,find,delete}`, `events.send`, `emails.send`, `lists.{subscribe,unsubscribe,list}`.
- [ ] Error model (`HogsendAPIError`, `RateLimitError`); share fetch core with CLI.
- [ ] Typed `template`/`props` via re-exported `TemplateRegistryMap`.
- [ ] Build (tsup), publish config; **first publish manual** (release skill).

**`packages/cli`**
- [ ] Add write commands: `events send`, `contacts upsert`, `emails send` (data-plane key). *(can slip to Phase 2)*
- [ ] Refactor `lib/http.ts` so `@hogsend/client` reuses the core.

**`packages/create-hogsend`**
- [ ] Scaffold API-key generation in `scripts/bootstrap.ts`; `src/lib/hogsend.ts`; `src/lists/`; README integration snippet.

**Phase 2**
- [ ] Webhook-source presets: Clerk, Supabase, Stripe, Segment (`packages/engine/src/webhook-sources/presets/`).
- [ ] Optional unscoped `hogsend` re-export package (if name obtainable).

**Phase 3**
- [ ] Outbound signed webhooks (table + signing + Hatchet delivery task).
- [ ] True contact merge/alias. Per-org data-plane scoping (use `organizationId`).

---

## 14. Migrations

1. **`contacts` identity** — `external_id` nullable + unique partial index on `email`. Backfill: none (existing rows already have `external_id`). Reversible.
2. **(Phase 1, no schema)** lists ride existing `email_preferences.categories`.
3. **(Phase 3)** `webhook_endpoints`.

Generate via `cd packages/db && pnpm db:generate`; engine-track migration. No destructive changes in Phase 1.

---

## 15. Acceptance criteria & test plan

**Identity / contacts**
- `PUT /v1/contacts {email}` (no userId) creates a contact; a later `{email,userId}` links them (`linked:true`).
- `find` by email and by userId both return the same contact.
- Property merge is additive; explicit `null` clears a key.

**Events / property split**
- `POST /v1/events` with `eventProperties`+`contactProperties`: event row has `eventProperties`; contact has only `contactProperties` merged; **event props do NOT leak into the contact**.
- A journey with `trigger.where` on an `eventProperty` fires; a bucket with criteria on a `contactProperty` updates membership.
- `Idempotency-Key` replay within window → `stored:false`, no duplicate.

**Transactional + tracking (§5)**
- `POST /v1/emails` inserts `email_sends`, rewrites links to `/v1/t/c/:id`, injects `/v1/t/o/:id` pixel, sends.
- Hitting the click URL records `link_clicks`, sets first `clickedAt`, 302s to the original, and ingests `email.link_clicked` (assert a bucket/journey can react).
- Open pixel sets first `openedAt` and ingests `email.opened`.
- Unsubscribed recipient → suppressed (no send) unless `skipPreferenceCheck` (which 403s without `full-admin`).

**Auth**
- Data-plane routes 401 without a key, 403 with a `read`-only key, 200/202 with `ingest`.
- `/v1/ingest` now requires a key (regression: previously open).

**Client**
- `@hogsend/client` round-trips each endpoint against the test app; typed `emails.send` rejects unknown template keys at compile time.

Tests live in `apps/api/src/__tests__/` via `app.request()` (no HTTP server), matching the existing pattern.

---

## 16. Phasing

- **Phase 1 — Front door (the unlock).** D1, D2, D5. Public `/v1/contacts`, `/v1/events`, `/v1/emails`. `@hogsend/client`. Retrofit `/v1/ingest` auth. → *Makes us "the open-source Loops."*
- **Phase 2 — Reach.** Lists (D3) + `/v1/lists`. CLI write commands. Webhook-source presets. `create-hogsend` wiring. Optional unscoped `hogsend` alias.
- **Phase 3 — Platform.** Outbound signed webhooks. True merge/alias. Per-org scoping. (Revisit Loops-compat shim.)

---

## 17. Sign-off checklist

- [x] **D1** identity model (canonical id + email-or-userId; externalId nullable) — *+ anonymous→identified via `anonymous_id` + real merge/alias resolver*
- [x] **D2** contactProperties/eventProperties split (accept the `ingestEvent` behavior change)
- [x] **D3** lists over existing categories store (vs dedicated tables)
- [x] **D4** PostHog optional/mirror posture
- [x] **D5** `ingest` scope + close the open `/v1/ingest`
- [x] **D6** `@hogsend/client` naming (+ optional `hogsend` alias)
- [x] Phase 1 scope (§16) is the agreed first cut
- [x] Shim stays deferred (revisit post-Phase-2)
- [x] Build proceeding on branch `feat/front-door` per `docs/front-door-build-plan.md`

Sign off the six decisions + Phase 1 scope and I'll start with the `db` migration + `resolveOrCreateContact`, then the routes, then the client.

---

## 18. Open questions

1. **Merge depth** in Phase 1 — fill-in + log only, or invest in true alias/merge now? *(rec: fill-in)*
2. **Event verb** — `events.send` (Loops) with a `track` alias? *(rec: yes)*
3. **Per-key rate limits** on `/v1/emails` day one? (`rate-limit.ts` exists.) *(rec: yes, conservative)*
4. **Unscoped `hogsend` name** — is it obtainable on npm? (gates D6's alias)
