# Outbound Webhooks + Integration Presets — Authoritative Build Plan

**Status:** LOCKED interface contract · conflict-free file ownership · ordered execution stages.
**Source spec:** `docs/front-door-spec.md` §9 (presets, Phase 2) + §10 (outbound webhooks, Phase 3).
**Scope:** Two features designed together.

- **(A) Outbound webhooks** — Hogsend emits a Svix-style HMAC-signed event stream to subscriber HTTP endpoints. 12-event catalog. Managed endpoints (CRUD + rotate-secret + test). Durable delivery via a Hatchet task with retry/backoff + dead-letter. `organizationId` column present + nullable; multi-tenancy DEFERRED (single-tenant behavior now).
- **(B) Integration presets** — Clerk, Supabase (`auth.users`), Stripe, Segment shipped as `defineWebhookSource` presets in the engine, enabled by env, each `transform()`-ing the provider payload into an `IngestEvent` with the D2 `contactProperties` vs `eventProperties` split.

Implementation agents build SOLELY from this doc plus the confirmed decisions in §6. Every signature here is canonical — where the 6 source module plans disagreed, this doc picks ONE and the divergent variants are dead.

---

## 0. Reconciliation summary (what changed vs the 6 module plans)

The 6 plans disagreed on column names, helper signatures, the emit-function name, and the delivery model. This is the resolution; implementation agents must use THESE, not the source plans:

| Conflict | Variants proposed | LOCKED choice |
|---|---|---|
| Endpoint on/off | `disabled` boolean (Schema) vs `disabledAt`/`deletedAt` timestamps (Delivery) vs `status` enum (Routes) | **`disabled` boolean** + **hard delete** (no `deletedAt`). Route serializes `status: "enabled"\|"disabled"` from the boolean. |
| Subscription column | `enabledEvents jsonb<string[]>` (Schema) vs `eventTypes text[]` (Delivery/Routes) | **`eventTypes jsonb<WebhookEventType[]>`** (jsonb, matches `apiKeys.scopes`/`emailPreferences.categories` precedent; NOT a normalized join table). |
| Secret column | `secret` plaintext (Schema/Emit) vs `signingSecret` (Delivery) vs `secretHash`+`secretPrefix` (Routes) | **`secret` (plaintext, recoverable)** + **`secretPrefix`** (display only). NO hash — outbound must re-sign every delivery (the one deliberate divergence from `api_keys`). |
| Delivery row: attempt count | `attempts` (Schema) vs `attemptCount` (Delivery) | **`attemptCount`**. |
| Delivery row: the Webhook-Id | `eventId` separate col (Schema) vs `id` reused (Delivery/Emit) | **`webhookId` text column** = the `Webhook-Id` header, generated ONCE per logical event, SHARED across all endpoint rows for that event + reused across retries. The row `id` (uuid PK) is internal-only. |
| Delivery status enum | `pending\|success\|failed\|dead` (Schema) vs `pending\|sending\|delivered\|failed\|discarded` (Delivery) | **`pending\|sending\|delivered\|failed\|discarded`** (need `sending` for CAS orphan recovery; `discarded` for operator-disabled endpoints). |
| Dedup key column | `eventId` (Schema) vs `dedupKey` (Delivery/Emit) | **`dedupeKey` text** (nullable) + unique `(endpointId, dedupeKey)` partial index. Separate from `webhookId`. |
| Sign helper signature | `signWebhook({id,timestamp?,payload,secret})→{headers,body}` (Schema) vs `signWebhookPayload({id,timestampSeconds,body,secret})→Record<string,string>` (Delivery) | **`signWebhook({id,timestamp,payload,secret})→{headers,body}`** (single canonical, §1.2). |
| Emit function | `emitOutbound({db,hatchet,logger,event,payload,dedupeKey?,organizationId?})` (Emit) vs `emitOutboundEvent({db,logger,eventType,data,organizationId?,dedupKey})` (Delivery) | **`emitOutbound`** with the Emit-module signature (typed per-event payloads), §1.4. |
| Delivery model | row+reaper (Delivery, Schema implied) vs in-task durable sleep | **row + 1-min reaper cron** (queryable, dead-letterable, orphan-recoverable; matches `reapStuckCampaignsTask`). |
| Route path | `/v1/admin/webhooks` (Routes) vs `/v1/admin/webhook-endpoints`/`outbound-webhooks` (reuse-map D-OW8) | **`/v1/admin/webhooks`** (Svix/Stripe/Loops convention; the inbound source route is `/v1/webhooks/:sourceId`, no collision since one is `/admin/`-prefixed). |
| Test event | catalog member vs out-of-band | **out-of-band `webhook.test`** delivered regardless of `eventTypes`. |
| Auth contract for presets | extend `defineWebhookSource` auth vs verify-in-transform | **extend** to a discriminated `WebhookSourceAuth` union with `"signature"`, raw-body in route (§5). |
| Stripe verify | `stripe` SDK vs `node:crypto` | **`node:crypto`** (no new heavy dep). |

---

## 1. LOCKED INTERFACE CONTRACT — Outbound Webhooks (A)

### 1.1 Database schema

Two new tables + one new enum. Reuse `timestamps` from `_shared.js`. `organizationId text("organization_id")` nullable, NO FK, NO scoping logic (mirrors `contacts.ts:17` / `api-keys.ts:15`).

**Enum** (`packages/db/src/schema/enums.ts`):
```ts
export const webhookDeliveryStatusEnum = pgEnum("webhook_delivery_status", [
  "pending",    // enqueued, awaiting first attempt OR a scheduled retry (nextRetryAt)
  "sending",    // a delivery run has CAS'd the row and is mid-POST (orphan-recovery sentinel)
  "delivered",  // 2xx received — TERMINAL
  "failed",     // attempts exhausted — TERMINAL, mirrored to dead_letter_queue
  "discarded",  // endpoint disabled/deleted mid-flight — TERMINAL, NOT an error, NOT dead-lettered
]);
```
Do NOT reuse `dlqStatusEnum` — its `pending|retried|discarded` lifecycle is for the generic DLQ, not per-endpoint delivery.

**Table `webhook_endpoints`** (`packages/db/src/schema/webhook-endpoints.ts`):
```ts
export const webhookEndpoints = pgTable("webhook_endpoints", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: text("organization_id"),               // nullable, MT deferred
  url: text("url").notNull(),
  description: text("description"),
  secret: text("secret").notNull(),                       // whsec_<base64url> PLAINTEXT (recoverable; re-signed every delivery)
  secretPrefix: text("secret_prefix").notNull(),          // e.g. "whsec_AbCd" — safe to show on list/get
  eventTypes: jsonb("event_types").$type<WebhookEventType[]>().notNull().default([]),
  disabled: boolean("disabled").notNull().default(false),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }), // written by delivery task
  ...timestamps,
}, (t) => [
  index("webhook_endpoints_org_idx").on(t.organizationId),
  index("webhook_endpoints_disabled_idx").on(t.disabled),
]);
```
`WebhookEventType` is imported from the engine signing lib's catalog (re-declared as a local type alias in the schema file or imported from `@hogsend/db` enums-adjacent constant — see §1.3; to avoid an engine→db dependency cycle the schema file declares its own `WebhookEventType = string` `$type` and the engine owns the authoritative tuple).

**Table `webhook_deliveries`** (`packages/db/src/schema/webhook-deliveries.ts`):
```ts
export const webhookDeliveries = pgTable("webhook_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),            // internal PK ONLY
  endpointId: uuid("endpoint_id").notNull()
    .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
  organizationId: text("organization_id"),               // denormalized, nullable
  webhookId: text("webhook_id").notNull(),               // == Webhook-Id header; ONE per logical event, shared across endpoints + reused across retries
  eventType: text("event_type").notNull(),
  dedupeKey: text("dedupe_key"),                          // producer-side dedup (idempotencyKey/stateId/emailSendId/...)
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(), // the EXACT signed envelope { id, type, timestamp, data }
  status: webhookDeliveryStatusEnum("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  nextRetryAt: timestamp("next_retry_at", { withTimezone: true }),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  responseStatus: integer("response_status"),
  responseBodySnippet: text("response_body_snippet"),    // truncated ≤1KB in app
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
}, (t) => [
  index("webhook_deliveries_endpoint_idx").on(t.endpointId),
  index("webhook_deliveries_status_next_retry_idx").on(t.status, t.nextRetryAt), // reaper sweep
  uniqueIndex("webhook_deliveries_endpoint_dedupe_idx")    // producer-side fan-out idempotency
    .on(t.endpointId, t.dedupeKey),
]);
```
NOTE: the unique index on `(endpointId, dedupeKey)` is PARTIAL-effective — Postgres treats multiple NULL `dedupeKey` as distinct, so events without a dedupeKey are never blocked. This is intentional (only deduped events carry a key). The `webhookId` is the SUBSCRIBER-side dedup key (Svix `Webhook-Id`); `dedupeKey` is the PRODUCER-side dedup (Hatchet-retry guard).

**Wiring (`packages/db/src/schema/index.ts`):** add `export * from "./webhook-endpoints.js";` and `export * from "./webhook-deliveries.js";`.

**Relations (`packages/db/src/schema/relations.ts`):** add `relations(webhookEndpoints, ({ many }) => ({ deliveries: many(webhookDeliveries) }))` and the inverse `relations(webhookDeliveries, ({ one }) => ({ endpoint: one(webhookEndpoints, ...) }))`, mirroring `trackedLinks↔linkClicks`.

**Migration:** after the schema files land, the USER runs `cd packages/db && pnpm db:generate` then `pnpm db:migrate`. NEVER run db commands on the user's behalf. The generated SQL creates the enum, both tables, indexes, and the FK in one migration — the user verifies CREATE TYPE/TABLE ordering before migrating.

### 1.2 Signing helpers (`packages/engine/src/lib/webhook-signing.ts`)

Reuse `svix` (already a `plugin-resend` dep at `^1.94.0`; add as a DIRECT engine dep via `pnpm --filter @hogsend/engine add svix@latest`). Svix's `Webhook` accepts a `whsec_`-prefixed base64 secret directly and its `.sign()` emits the unprefixed `Webhook-Id`/`Webhook-Timestamp`/`Webhook-Signature` header set with a `v1,<base64>` signature.

```ts
// The 12-event catalog — the SINGLE source of truth (schema, routes, client, CLI all derive from this).
export const WEBHOOK_EVENT_TYPES = [
  "contact.created", "contact.updated", "contact.deleted", "contact.unsubscribed",
  "email.sent", "email.delivered", "email.opened", "email.clicked", "email.bounced",
  "journey.completed", "bucket.entered", "bucket.left",
] as const;
export type WebhookEventType = (typeof WEBHOOK_EVENT_TYPES)[number];

// whsec_<base64url(32 bytes)>. Returns the full secret + its display prefix.
export function generateWebhookSecret(): { secret: string; secretPrefix: string };
// → { secret: `whsec_${randomBytes(32).toString("base64url")}`, secretPrefix: secret.slice(0, 12) }

export interface SignedWebhook {
  headers: { "Webhook-Id": string; "Webhook-Timestamp": string; "Webhook-Signature": string; "Content-Type": "application/json" };
  body: string; // the EXACT bytes that were signed AND must be sent (never re-stringify between sign and send)
}

// Canonical: signedContent = `${id}.${timestampSeconds}.${body}`, HMAC-SHA256, header `v1,<base64sig>`.
export function signWebhook(opts: {
  id: string;               // the Webhook-Id (stable per logical event)
  timestamp: number;        // unix SECONDS (required — caller passes Math.floor(Date.now()/1000))
  payload: unknown;         // object → JSON.stringify; string → used as-is
  secret: string;           // the whsec_ plaintext
}): SignedWebhook;

// Consumer/test-facing verify (5-min tolerance, constant-time compare inside svix). Throws on bad sig/stale ts.
// Normalizes Title-Case AND lowercase header keys.
export function verifyWebhookSignature(opts: {
  payload: string;
  headers: Record<string, string>;
  secret: string;
}): unknown;
```
Pure `node:crypto` fallback documented in a code comment for the SDK/spec: `createHmac("sha256", Buffer.from(secret.slice(6), "base64")).update(`${id}.${ts}.${body}`).digest("base64")` → header `v1,${sig}`, compare with `timingSafeEqual`.

Re-exported from `packages/engine/src/index.ts`: `generateWebhookSecret`, `signWebhook`, `verifyWebhookSignature`, `WEBHOOK_EVENT_TYPES`, `WebhookEventType`.

### 1.3 Catalog as the single source of truth

`WEBHOOK_EVENT_TYPES` (12 strings) in `webhook-signing.ts` is canonical. The `webhook.test` sentinel is NOT a catalog member (out-of-band). The Routes module's `z.enum(...)` validation, the client `OutboundEventType` union, and the CLI `--all-events` expansion ALL derive from this tuple (client/CLI re-declare the same string union since they can't import the engine; a drift test asserts equality).

### 1.4 Emit spine (`packages/engine/src/lib/outbound.ts`)

ONE fire-and-forget function. It does NOT deliver — it selects subscribed endpoints, inserts one `webhook_deliveries` row per endpoint (sharing one `webhookId`), and enqueues the durable task. Never throws to callers (callers STILL wrap in `.catch()`).

```ts
export const OUTBOUND_EVENTS = WEBHOOK_EVENT_TYPES;        // re-export of the catalog
export type OutboundEventName = WebhookEventType;

interface EmailEventPayload { emailSendId: string; resendId: string | null; templateKey: string | null; userId: string | null; to: string; at: string }
interface BucketEventPayload { bucketId: string; bucketName: string; userId: string; userEmail: string | null; transition: "entered" | "left"; entryCount: number; source: string }

export interface OutboundPayloads {
  "contact.created": SerializedContact;
  "contact.updated": SerializedContact;
  "contact.deleted": { id: string; externalId: string | null; email: string | null };
  "contact.unsubscribed": { externalId: string | null; email: string | null; category: string | null; scope: "all" | "category" };
  "email.sent": { emailSendId: string; resendId: string; templateKey: string | null; to: string; userId: string | null; category: string | null; journeyStateId: string | null; subject: string; sentAt: string };
  "email.delivered": EmailEventPayload;
  "email.opened": EmailEventPayload;
  "email.clicked": EmailEventPayload & { linkUrl?: string; linkId?: string };
  "email.bounced": EmailEventPayload & { bounceType?: string; bounceReason?: string };
  "journey.completed": { journeyId: string; journeyName: string; stateId: string; userId: string; userEmail: string; completedAt: string };
  "bucket.entered": BucketEventPayload;
  "bucket.left": BucketEventPayload & { reason?: string };
}

export async function emitOutbound<E extends OutboundEventName>(opts: {
  db: Database;
  hatchet: HatchetClient;
  logger: Logger;
  event: E;
  payload: OutboundPayloads[E];
  dedupeKey?: string;
  organizationId?: string | null;   // default null (single-tenant)
}): Promise<void>;
```
Internals:
1. `webhookId = `msg_${crypto.randomUUID()}``, `timestamp = new Date()`.
2. SELECT active endpoints WHERE `disabled = false` AND `eventTypes @> '["<event>"]'` AND (single-tenant: `organizationId IS NULL`). Short-circuit return if none.
3. `envelope = { id: webhookId, type: event, timestamp: timestamp.toISOString(), data: payload }`.
4. INSERT one `webhook_deliveries` row per endpoint: `{ endpointId, organizationId, webhookId, eventType: event, dedupeKey, payload: envelope, status: "pending", attemptCount: 0, nextRetryAt: timestamp }`, `.onConflictDoNothing({ target: [endpointId, dedupeKey] })`, `.returning({ id })`.
5. `deliverWebhookTask.runNoWait({ deliveryId })` for each inserted row, fire-and-forget (`.catch(logger.warn)` — the reaper picks up an enqueue that fails).

The delivery task signs from the FROZEN `payload` envelope on the row + the LIVE endpoint secret (read at delivery time). Rationale for live-secret-read: a rotate-secret should invalidate in-flight deliveries to a compromised secret; the at-least-once + reaper model tolerates it. (If a grace window is wanted later, that is the Phase-3 follow-up in §6.)

Also in this file (or `tracking-events.ts`): `resolveEmailSendContextByResendId(db, resendId): Promise<{ emailSendId; userId; userEmail; templateKey; to } | null>` — mirror of `resolveEmailSendContext` but joining on `emailSends.resendId` (for the provider-webhook enrichment path).

Re-exported from `packages/engine/src/index.ts`: `emitOutbound`, `OUTBOUND_EVENTS`, `OutboundEventName`, `OutboundPayloads`, `resolveEmailSendContextByResendId`.

### 1.5 Durable delivery task + reaper (`packages/engine/src/workflows/deliver-webhook.ts`)

```ts
export const deliverWebhookTask = hatchet.task<{ deliveryId: string }>({
  name: "deliver-webhook",
  retries: 0,                  // the reaper (nextRetryAt) IS the retry scheduler, not Hatchet backoff
  executionTimeout: "30s",
  fn: async (input) => { /* one POST attempt — see flow below */ },
});

export const reapDueWebhookDeliveriesTask = hatchet.task({
  name: "reap-due-webhook-deliveries",
  onCrons: [process.env.OUTBOUND_WEBHOOK_REAPER_CRON ?? "*/1 * * * *"],
  retries: 1,
  executionTimeout: "120s",
  fn: async () => { /* re-drive due pending + recover stale sending — see flow below */ },
});
```

Tunables (env, all optional with defaults): `OUTBOUND_WEBHOOK_MAX_ATTEMPTS` (default **8**), `OUTBOUND_WEBHOOK_TIMEOUT_MS` (default **15000**), `OUTBOUND_WEBHOOK_BASE_DELAY_MS` (default **5000**), `OUTBOUND_WEBHOOK_MAX_DELAY_MS` (default **21600000** = 6h), `OUTBOUND_WEBHOOK_REAPER_CRON` (default `*/1 * * * *`), `OUTBOUND_WEBHOOK_STUCK_AFTER_MS` (default **300000** = 5min).

`deliverWebhookTask.fn` flow (self-boots `getDb()` + `createLogger`):
1. Load delivery row by `id`; return `{status:"skipped", reason:"not_found"}` if absent; return early if status is terminal (`delivered`/`failed`/`discarded`).
2. Load endpoint. If absent OR `endpoint.disabled`: CAS the delivery to `discarded` (`nextRetryAt: null`) and return — operator action, not a delivery error, no dead-letter.
3. CAS the row to `sending` (so an overlapping reaper re-drive can't double-POST).
4. `const { headers, body } = signWebhook({ id: row.webhookId, timestamp: Math.floor(Date.now()/1000), payload: row.payload, secret: endpoint.secret })`. The `body` is the EXACT bytes signed AND sent.
5. `fetch(endpoint.url, { method:"POST", headers, body, signal })` with `AbortController` timeout. Capture `responseStatus`, truncate response text to ≤1KB into `responseBodySnippet`.
6. **2xx** → `delivered` (+ `deliveredAt`, `lastError: null`, `nextRetryAt: null`); also bump `webhookEndpoints.lastDeliveryAt`.
7. **Fast-fail 4xx** (except `408`/`429`): treat persistent client errors as permanent after attempt ≥2 — go straight to dead-letter (a `410 Gone` shouldn't retry 8×). `429` + `408` + `5xx` + network/timeout are retryable. (Mirrors `plugin-resend` `isRetryableStatusCode`.)
8. **Retryable failure, attempts < MAX** → `pending`, `attemptCount++`, `nextRetryAt = now + backoffMs(attemptCount)` where `backoffMs = min(BASE * 2^attempt + jitter(0..BASE), MAX_DELAY)`.
9. **Exhausted (attempts ≥ MAX) or fast-fail** → in a transaction: set `failed` + INSERT `dead_letter_queue` `{ source: "webhook-delivery", sourceId: <deliveryId>, payload: { endpointId, url, eventType, webhookId, body: row.payload }, error: `Exhausted ${attemptCount}: ${lastError}`, retryCount: attemptCount, status: "pending" }`. This is the DLQ's first real producer.

`reapDueWebhookDeliveriesTask.fn` (cloned from `reapStuckCampaignsTask`):
- SELECT up to 500 rows WHERE `(status='pending' AND (nextRetryAt IS NULL OR nextRetryAt <= now))` OR `(status='sending' AND updatedAt < stuckBefore)`.
- For each, `await deliverWebhookTask.run({ deliveryId })` wrapped in try/catch (warn on failure). This is the retry scheduler AND the orphan-`sending` recovery.

Worker registration (`packages/engine/src/worker.ts`): import and append `deliverWebhookTask, reapDueWebhookDeliveriesTask` to `baseWorkflows` (the array at lines 66-77), exactly like `sendCampaignTask`/`reapStuckCampaignsTask`. `builtinTasks` math self-adjusts.

### 1.6 The 12 emit hook points (EXACT, file-verified)

All call sites use `void emitOutbound(...).catch(logger.warn)` — never awaited on the request/ingest/journey hot path. A grep for un-`.catch()`'d `emitOutbound` is a review gate.

| Event | File + point | Payload source | Notes |
|---|---|---|---|
| `contact.created` / `contact.updated` | `routes/contacts/index.ts` upsertRoute (~line 139). Also `routes/admin/contacts.ts` (~271, ~306) and `routes/lists/index.ts` (~146). | `serializeContact(row)` — needs a `resolveContact({db,id})` read-back (the route only gets `{id,created,linked}`). | Emit at the **INTENT/route layer** using the `{created,linked,merged}` flags — NOT inside `resolveOrCreateContact`/`ingestEvent` (which run on every event → would fire on every pageview). `created===true` → created; `created===false && (linked\|\|merged) && non-empty property delta` → updated. Lists route emits `contact.created` only on first creation. |
| `contact.deleted` | `routes/contacts/index.ts` deleteRoute (~line 182) after `softDeleteContact` returns deleted identity. | `{ id, externalId, email }` | **`softDeleteContact` MUST be widened** (§1.7). |
| `contact.unsubscribed` | `lib/preferences.ts` `upsertEmailPreference` (line 17), the single choke for ALL pref writes (token unsub, preference center, list-membership flips). | `{ externalId, email, category: update.categoryKey ?? null, scope }` | GATED on `update.unsubscribedAll===true \|\| update.categoryValue===false`. Do NOT emit on resubscribe. Thread `hatchet`+`logger` via singletons (`getDb`/`hatchet` already used in engine libs). |
| `email.sent` | `lib/tracked.ts` `sendTrackedEmail` immediately after the `status:"sent"` UPDATE (~line 273). | rich: emailSendId, resendId=result.id, templateKey, to, userId, category, journeyStateId, subject, sentAt. | `dedupeKey: `email.sent:${emailSendId}``. Do NOT emit on suppressed/frequency-capped/failed branches, nor the `db===undefined` mailer fallback. Thread `hatchet` into the tracked-mailer deps. |
| `email.delivered` / `email.bounced` | `lib/mailer.ts` `dispatchWebhook` switch (~line 188). | enrich via `resolveEmailSendContextByResendId(db, event.data.email_id)`. bounced adds `{bounceType, bounceReason}`. | Provider-webhook funnel. Thread `hatchet` into the mailer config. |
| `email.opened` | `routes/tracking/open.ts` (~line 40). | `resolveEmailSendContext` (already pulled for `pushTrackingEvent`). | **First-party is the SINGLE emitter.** Change the `openedAt` UPDATE to `.returning({id})`; emit only when a row was returned (the existing `WHERE openedAt IS NULL` makes it first-touch). `dedupeKey: `email.opened:${id}``. The provider-side open echo in mailer is SUPPRESSED. `hatchet`/`logger` already in container. |
| `email.clicked` | `routes/tracking/click.ts` (~lines 64-75). | ctx + `{linkUrl: link.originalUrl, linkId: link.id}`. | Split the `clickedAt` UPDATE out of the `Promise.all` to capture `.returning()`; emit on first click only. `dedupeKey: `email.clicked:${emailSendId}``. |
| `journey.completed` | `journeys/define-journey.ts` (~line 202) after the `status:"completed"` UPDATE + the existing `journey:completed` push. | `{ journeyId: meta.id, journeyName: meta.name, stateId, userId, userEmail, completedAt }`. | Runs in the WORKER — use `getDb()`/`hatchet`/`logger` singletons (already imported). `dedupeKey: `journey.completed:${stateId}``. Do NOT emit on `journey:failed` (not in catalog). |
| `bucket.entered` / `bucket.left` | `lib/bucket-emit.ts` `emitBucketTransition` (the SINGLE producer for all 3 origins). | `{ bucketId, bucketName, userId, userEmail, transition, entryCount: epoch, source, reason? }`. | GATE `kind==="entered"\|\|kind==="left"` (skip `dwell`, exactly like the existing PostHog-mirror gate at line 110). `dedupeKey: idempotencyKey` (deterministic across all 3 producers → survives Hatchet retries). `db`/`hatchet`/`logger` already destructured. |

**Explicit NON-emit (documented gaps, not bugs):** `import-contacts.ts` bulk path calls `resolveOrCreateContact` directly per-row — it MUST NOT emit `contact.created` (would flood on a 100k import). `journey.failed`, `email.complained`, and bucket `dwell` are NOT in the catalog and are NOT emitted.

### 1.7 Supporting widenings

- `lib/contacts.ts` `softDeleteContact`: widen return `Promise<boolean>` → `Promise<{ deleted: boolean; id?: string; externalId?: string | null; email?: string | null }>` using the existing `.returning()` (add `externalId`, `email` to the returning columns). The delete route uses `result.deleted` for the 404 check and the identity for the payload. (All callers updated — see fileOwnership.)
- `lib/tracking-events.ts`: add `resolveEmailSendContextByResendId` (joining `emailSends.resendId`).

### 1.8 Admin management routes (`packages/engine/src/routes/admin/webhooks.ts`)

Mounted at `/v1/admin/webhooks` — inherits `requireAdmin` + `rateLimit` + `auditMiddleware` from the admin router root (NO per-route auth). Clone of `routes/admin/api-keys.ts`. The `secret` (full `whsec_…`) is returned ONLY on create + rotate-secret, NEVER on list/get (which expose `secretPrefix` only).

Routes:
| Method + path | Purpose | Response |
|---|---|---|
| `GET /` | List (`limit/offset/includeDisabled`). | `{ endpoints: WebhookEndpoint[], total, limit, offset }` |
| `POST /` | Create. Body `{ url, eventTypes: z.enum(WEBHOOK_EVENT_TYPES).array().min(1), description?, disabled? }`. | `201` `WebhookEndpoint & { secret: string }` |
| `GET /{id}` | Get one. | `200` `WebhookEndpoint` / `404` |
| `PATCH /{id}` | Update `{ url?, eventTypes?, description?, disabled? }`. | `200` `WebhookEndpoint` / `404` |
| `DELETE /{id}` | Hard delete (cascade drops deliveries). | `200 { deleted: true }` / `404` |
| `POST /{id}/rotate-secret` | New `generateWebhookSecret()`, update `secret`+`secretPrefix`. | `200 { id, secret, secretPrefix }` / `404` |
| `POST /{id}/test` | Enqueue `deliverWebhookTask` with an out-of-band `webhook.test` event (delivered regardless of `eventTypes`). Enqueue-and-202, tolerate broker failure (warn + still 202). | `202 { enqueued: true, eventType: "webhook.test" }` / `404` |

`serializeEndpoint(row)` → `{ id, url, description, eventTypes, secretPrefix, status: row.disabled ? "disabled" : "enabled", organizationId, lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null, createdAt, updatedAt }`. NEVER includes `secret`.

The `POST /{id}/test` handler builds a synthetic delivery: it generates a `webhookId`, inserts ONE `webhook_deliveries` row for the target endpoint with `payload = { id, type: "webhook.test", timestamp, data: { message: "Hogsend test event", endpointId, sentAt } }`, then `deliverWebhookTask.runNoWait({ deliveryId })`. (It does NOT go through `emitOutbound` because that filters by subscription.)

Registration (`packages/engine/src/routes/admin/index.ts`): `import { webhooksRouter } from "./webhooks.js";` + `adminRouter.route("/webhooks", webhooksRouter);` (after `/api-keys`).

`env.ts`: add `OUTBOUND_WEBHOOK_REAPER_CRON` (and the other tunables in §1.5) as optional `z.string().optional()` / `z.coerce.number().optional()` — only the ones read off the validated `env` object; the task-internal `process.env.X` reads do not strictly need env-schema entries but ADD `OUTBOUND_WEBHOOK_REAPER_CRON` for parity with `BUCKET_RECONCILE_CRON`.

### 1.9 `@hogsend/client` surface — `hs.webhooks.*`

Targets the ADMIN routes; documented to require a full-admin key (NOT the ingest key the rest of the client uses).

```ts
class WebhooksResource {
  create(input: CreateWebhookInput): Promise<CreatedWebhookEndpoint>;          // POST /v1/admin/webhooks
  list(opts?: { limit?: number; offset?: number; includeDisabled?: boolean }): Promise<WebhookEndpoint[]>;
  get(id: string): Promise<WebhookEndpoint>;
  update(id: string, input: UpdateWebhookInput): Promise<WebhookEndpoint>;     // PATCH
  delete(id: string): Promise<{ deleted: boolean }>;
  rotateSecret(id: string): Promise<RotateWebhookSecretResult>;
  sendTest(id: string): Promise<{ enqueued: boolean; eventType: "webhook.test" }>;
}
```
Types (`packages/client/src/types.ts`, re-exported from `index.ts`):
```ts
type OutboundEventType = /* the 12-string union, mirrors WEBHOOK_EVENT_TYPES */;
interface WebhookEndpoint { id: string; url: string; description: string | null; eventTypes: OutboundEventType[]; secretPrefix: string; status: "enabled" | "disabled"; organizationId: string | null; lastDeliveryAt: string | null; createdAt: string; updatedAt: string }
type CreatedWebhookEndpoint = WebhookEndpoint & { secret: string };
interface CreateWebhookInput { url: string; eventTypes: OutboundEventType[]; description?: string; disabled?: boolean }
interface UpdateWebhookInput { url?: string; eventTypes?: OutboundEventType[]; description?: string | null; disabled?: boolean }
interface RotateWebhookSecretResult { id: string; secret: string; secretPrefix: string }
```
`packages/client/src/internal/http.ts`: add `patch<T>(path, body, extras?)` to the `HttpClient` interface + `createHttpClient` return (one line `request<T>("PATCH", ...)`) — `webhooks.update` needs it (currently only get/post/put/del).
`packages/client/src/hogsend.ts`: add `readonly webhooks: WebhooksResource;`, construct it, JSDoc the full-admin-key requirement.

**Also ship the subscriber-side verify helper** `verifyHogsendWebhook({ payload, headers, secret })` in `@hogsend/client` (wraps the same svix verify / node:crypto fallback as §1.2) so consumers validate inbound Hogsend deliveries — the "build ON Hogsend" completeness piece. Exported from `packages/client/src/index.ts`.

### 1.10 `hogsend` CLI — `hogsend webhooks`

`packages/cli/src/commands/webhooks.ts`, admin-key authed via `ctx.http` (NOT `ctx.dataHttp`). Subcommands: `list | get <id> | create | update <id> | delete <id> | rotate-secret <id> | test <id>`. `create` flags: `--url` (req), `--event <type>` (repeatable → `eventTypes[]`), `--all-events`, `--description`, `--disabled`. `create`/`rotate-secret` print the secret ONCE with a yellow WARNING. `--all-events` expands from the vendored 12-string catalog const.
`packages/cli/src/commands/index.ts`: import + add `webhooksCommand` (after `campaignsCommand`).
`packages/cli/src/lib/http.ts`: add `patch` and `del` to the `AdminClient` interface + `createAdminClient` (currently get/patch/post only — no `del`) — `webhooks delete` needs `del`, `webhooks update` needs `patch`.

---

## 2. LOCKED INTERFACE CONTRACT — Integration Presets (B)

### 2.1 The shared prerequisite: widen `defineWebhookSource` auth + raw body

`packages/engine/src/webhook-sources/define-webhook-source.ts` — widen `WebhookSourceAuth` to a discriminated union (the existing `"match"` variant is UNCHANGED so posthog + all consumer sources keep compiling):
```ts
export type WebhookSourceAuth =
  | { type: "match"; header: string; envKey: string }
  | { type: "signature"; scheme: "svix" | "stripe" | "hmac-hex"; envKey: string; header: string;
      fallbackMatchHeader?: string;
      verify?(args: { rawBody: string; headers: Record<string, string>; secret: string }): boolean | Promise<boolean> };

export interface WebhookSourceCtx {
  db: Database;
  logger: Logger;
  rawBody?: string;                          // NEW — for signature schemes / provider-specific needs
  headers?: Record<string, string>;          // NEW
}
```
Add a built-in `verifySignature(scheme, { rawBody, headers, secret })` helper (in `define-webhook-source.ts` or a sibling `verify.ts`):
- `"svix"` → `new Webhook(secret).verify(rawBody, { "svix-id", "svix-timestamp", "svix-signature" })` (reuse the plugin-resend pattern); a `fallbackMatchHeader` falls back to plain shared-secret equality when the svix headers are absent.
- `"stripe"` → parse `stripe-signature: t=<ts>,v1=<hex>`, compute `HMAC_SHA256(secret, `${t}.${rawBody}`)`, `timingSafeEqual` compare, 5-min tolerance. **`node:crypto` only — NO `stripe` SDK dependency.**
- `"hmac-hex"` → `HMAC_SHA256(secret, rawBody)` hex, `timingSafeEqual` compare.

`packages/engine/src/routes/webhooks/sources.ts` — two changes:
1. Read the body ONCE as raw text: `const rawBody = await c.req.text()`; collect all headers into a record; `JSON.parse(rawBody)` ONLY after auth.
2. Branch on `source.auth.type`: `"match"` keeps the current header-equality logic (unconfigured secret stays OPEN, parity); `"signature"` calls `verifySignature(...)` and **fails CLOSED (401) when the secret is absent** (deliberate divergence — signature presets are security-sensitive). Pass `{ db, logger, rawBody, headers }` into `transform`.

### 2.2 Env

`packages/engine/src/env.ts` server block (all `z.string().min(1).optional()`, mirroring `POSTHOG_WEBHOOK_SECRET`): `CLERK_WEBHOOK_SECRET`, `SUPABASE_WEBHOOK_SECRET`, `STRIPE_WEBHOOK_SECRET`, `SEGMENT_WEBHOOK_SECRET`, plus `ENABLED_WEBHOOK_PRESETS: z.string().optional()` (csv / `"*"` / `"none"`). These MUST exist on the validated env because the route resolves secrets via `env[source.auth.envKey]`.

### 2.3 Presets (`packages/engine/src/webhook-sources/presets/`)

Each is a `defineWebhookSource` with `auth.type: "signature"`, a permissive Zod schema (`.catchall(z.unknown())`, `.nullish()`), and a `transform()` that returns an `IngestEvent | null` with the STRICT D2 split: provider profile/identity → `contactProperties` ONLY; behavioral → `eventProperties` ONLY (NEVER merged — mirror `apps/api/src/webhook-sources/posthog.ts`).

- **`clerk.ts`** — `auth: { type:"signature", scheme:"svix", envKey:"CLERK_WEBHOOK_SECRET", header:"svix-signature" }`. `user.created→contact.created`, `user.updated→contact.updated`, `user.deleted→contact.deleted`; `waitlistEntry.*→waitlist.joined`. `userId = clerk user id`; primary email from `email_addresses`. `contactProperties`: `{ firstName, lastName, avatarUrl, ...public_metadata }`. `eventProperties`: `{ source:"clerk", clerkUserId, _clerkEvent }`.
- **`supabase.ts`** — `auth: { type:"signature", scheme:"svix", envKey:"SUPABASE_WEBHOOK_SECRET", header:"svix-signature", fallbackMatchHeader:"x-supabase-webhook-secret" }`. Envelope `{ type:INSERT|UPDATE|DELETE, table, schema, record, old_record }`; only `schema==="auth" && table==="users"`. `INSERT→contact.created`, `UPDATE→contact.updated`, `DELETE→contact.deleted`. `userId = row.id`. `contactProperties`: `{ phone, emailVerified, ...raw_user_meta_data }`.
- **`stripe.ts`** — `auth: { type:"signature", scheme:"stripe", envKey:"STRIPE_WEBHOOK_SECRET", header:"stripe-signature" }`. `customer.created/updated/deleted → contact.created/updated/deleted`; `customer.subscription.* → subscription.<action>`; `invoice.* → invoice.<action>`. `userId = obj.id` (customer) or `obj.customer` (sub/invoice). **`idempotencyKey = payload.id`** (Stripe event id — dedupes at-least-once redelivery).
- **`segment.ts`** — `auth: { type:"signature", scheme:"hmac-hex", envKey:"SEGMENT_WEBHOOK_SECRET", header:"x-signature" }`. `identify → contact.updated` (traits → `contactProperties` only); `track → <event name>` (properties → `eventProperties` only). `idempotencyKey = messageId`. `page/screen/group/alias → null` (skip).
- **`presets/index.ts`** — `PRESET_SOURCES = { clerk, supabase, stripe, segment }`, `presetsFromEnv(env)` (returns presets whose `auth.envKey` secret is set; honors `ENABLED_WEBHOOK_PRESETS` csv/`*`/`none`), plus named exports of each source.

**Property-naming convention (all presets):** camelCase for profile fields (`firstName`); provider-prefixed for external ids (`clerkUserId`, `stripeCustomerId`, `supabaseUserId`).

### 2.4 Enablement (`packages/engine/src/app.ts`)

`createApp` merges env-enabled presets with the consumer's explicit `webhookSources` before `registerRoutes`: `const sources = enablePresets ? dedupeById([...presetsFromEnv(client.env), ...(opts.webhookSources ?? [])]) : (opts.webhookSources ?? [])` (consumer-supplied wins on id collision). Add `enablePresets?: boolean` (default **true**) to `CreateAppOptions`. So setting only `STRIPE_WEBHOOK_SECRET` auto-enables Stripe at `POST /v1/webhooks/stripe` and nothing else; consumers can also `webhookSources: [stripeSource]` explicitly.

Engine barrel (`packages/engine/src/index.ts`): export `PRESET_SOURCES`, `presetsFromEnv`, `clerkSource`, `supabaseSource`, `stripeSource`, `segmentSource`, `PresetId`, `verifySignature`, and the widened `WebhookSourceAuth`/`WebhookSourceCtx` types.

### 2.5 `user.deleted` / `customer.deleted` semantics

An `IngestEvent` CANNOT soft-delete a contact (`softDeleteContact` is a dedicated path, not reachable via `ingestEvent`). For Phase 2 the presets emit `contact.deleted` as an EVENT only (drives journeys + the OUTBOUND `contact.deleted` webhook if also enabled); a real soft-delete side-channel is DEFERRED (§6, D-IP-DELETE).

### 2.6 Scaffold docs

`packages/create-hogsend/template/env.example`: document the 4 preset secrets + `ENABLED_WEBHOOK_PRESETS` as commented-out lines with the auto-enable note. NO change to the template's `webhook-sources/index.ts` (presets auto-enable via env).

---

## 3. FILE OWNERSHIP (exactly one execution stage per file)

Grouped so same-`parallelGroup` stages never touch the same directory. `S1`–`S9` are the stage ids in §4.

### S1 — DB schema + signing core (parallelGroup 1)
| Path | Action |
|---|---|
| `packages/db/src/schema/webhook-endpoints.ts` | create |
| `packages/db/src/schema/webhook-deliveries.ts` | create |
| `packages/db/src/schema/enums.ts` | modify (add `webhookDeliveryStatusEnum`) |
| `packages/db/src/schema/index.ts` | modify (2 exports) |
| `packages/db/src/schema/relations.ts` | modify (endpoint↔deliveries relations) |
| `packages/engine/src/lib/webhook-signing.ts` | create (signing + catalog) |
| `packages/engine/package.json` | modify (add `svix` direct dep) |

### S2 — Emit spine + supporting widenings (parallelGroup 2)
| Path | Action |
|---|---|
| `packages/engine/src/lib/outbound.ts` | create (`emitOutbound`, payloads, `resolveEmailSendContextByResendId` if placed here) |
| `packages/engine/src/lib/tracking-events.ts` | modify (add `resolveEmailSendContextByResendId`) |
| `packages/engine/src/lib/contacts.ts` | modify (widen `softDeleteContact` return) |

### S3 — Durable delivery task + reaper + worker wire (parallelGroup 3)
| Path | Action |
|---|---|
| `packages/engine/src/workflows/deliver-webhook.ts` | create (`deliverWebhookTask`, `reapDueWebhookDeliveriesTask`) |
| `packages/engine/src/worker.ts` | modify (register both tasks in `baseWorkflows`) |

### S4 — Emit hook-point wiring (parallelGroup 4) — touches many engine call sites; serialized into ONE stage to avoid collisions
| Path | Action |
|---|---|
| `packages/engine/src/routes/contacts/index.ts` | modify (contact.created/updated/deleted emits) |
| `packages/engine/src/routes/admin/contacts.ts` | modify (contact.created/updated emits) |
| `packages/engine/src/routes/lists/index.ts` | modify (contact.created emit) |
| `packages/engine/src/lib/preferences.ts` | modify (contact.unsubscribed choke) |
| `packages/engine/src/lib/tracked.ts` | modify (email.sent emit + thread hatchet) |
| `packages/engine/src/lib/mailer.ts` | modify (email.delivered/bounced emit + thread hatchet; suppress provider open/click echo) |
| `packages/engine/src/routes/tracking/open.ts` | modify (email.opened first-touch emit) |
| `packages/engine/src/routes/tracking/click.ts` | modify (email.clicked first-touch emit) |
| `packages/engine/src/journeys/define-journey.ts` | modify (journey.completed emit) |
| `packages/engine/src/lib/bucket-emit.ts` | modify (bucket.entered/left emit) |

### S5 — Admin routes + engine barrel + env (parallelGroup 5)
| Path | Action |
|---|---|
| `packages/engine/src/routes/admin/webhooks.ts` | create |
| `packages/engine/src/routes/admin/index.ts` | modify (mount `/webhooks`) |
| `packages/engine/src/env.ts` | modify (outbound crons/tunables + 4 preset secrets + `ENABLED_WEBHOOK_PRESETS`) |
| `packages/engine/src/index.ts` | modify (re-export signing, emit, presets, verify helpers — single owner of the barrel) |

### S6 — `@hogsend/client` + `hogsend` CLI (parallelGroup 6)
| Path | Action |
|---|---|
| `packages/client/src/resources/webhooks.ts` | create |
| `packages/client/src/internal/http.ts` | modify (add `patch`) |
| `packages/client/src/hogsend.ts` | modify (wire `webhooks` resource) |
| `packages/client/src/types.ts` | modify (webhook types) |
| `packages/client/src/index.ts` | modify (re-export types + `verifyHogsendWebhook`) |
| `packages/client/src/internal/verify.ts` | create (`verifyHogsendWebhook`) |
| `packages/cli/src/commands/webhooks.ts` | create |
| `packages/cli/src/commands/index.ts` | modify (register command) |
| `packages/cli/src/lib/http.ts` | modify (add `patch`+`del` to AdminClient) |

### S7 — Presets: auth contract widening (parallelGroup 7)
| Path | Action |
|---|---|
| `packages/engine/src/webhook-sources/define-webhook-source.ts` | modify (widen auth union + ctx; `verifySignature`) |
| `packages/engine/src/webhook-sources/verify.ts` | create (optional split of `verifySignature`) |
| `packages/engine/src/routes/webhooks/sources.ts` | modify (raw body + signature branch) |

### S8 — Presets: the 4 sources + app wire + scaffold (parallelGroup 8)
| Path | Action |
|---|---|
| `packages/engine/src/webhook-sources/presets/clerk.ts` | create |
| `packages/engine/src/webhook-sources/presets/supabase.ts` | create |
| `packages/engine/src/webhook-sources/presets/stripe.ts` | create |
| `packages/engine/src/webhook-sources/presets/segment.ts` | create |
| `packages/engine/src/webhook-sources/presets/index.ts` | create |
| `packages/engine/src/app.ts` | modify (merge presets + `enablePresets`) |
| `packages/create-hogsend/template/env.example` | modify (document preset secrets) |

> NOTE: `packages/engine/src/index.ts` and `packages/engine/src/env.ts` are owned by S5 ONLY. S7/S8 must NOT edit them — the S5 owner adds ALL barrel exports (signing, emit, presets, verify) and ALL env keys (outbound + preset) in one pass. This is why S5 depends on the interface names from S7/S8 being known (they are, from this doc) but not on their code landing — S5 can run as soon as the catalog/preset NAMES are fixed (they are, here). To keep it simple, the execution order puts S5 after S2/S3 and lets S7/S8 land in parallel groups that do not touch the barrel/env.

### S9 — Tests (parallelGroup 9)
| Path | Action |
|---|---|
| `apps/api/src/__tests__/outbound-webhooks-signing.test.ts` | create (sign→verify round-trip, both header casings, node:crypto parity) |
| `apps/api/src/__tests__/outbound-webhooks-delivery.test.ts` | create (task: 2xx→delivered, retry→nextRetryAt, exhaust→failed+DLQ, disabled→discarded, reaper re-drive) |
| `apps/api/src/__tests__/outbound-webhooks-emit.test.ts` | create (each of the 12 emit points fires exactly once; no double-emit on open/click; no per-row emit on bulk import) |
| `apps/api/src/__tests__/outbound-webhooks-routes.test.ts` | create (CRUD, secret-once invariant: no `secret`/`secretPrefix`-leak on list/get, rotate, test) |
| `apps/api/src/__tests__/webhook-presets.test.ts` | create (each preset transform + signature verify fail-closed + D2 split + idempotencyKey) |

---

## 4. EXECUTION STAGES (ordered, with parallel groups)

| Stage | parallelGroup | Summary | dependsOn |
|---|---|---|---|
| **S1 — Schema + signing** | 1 | Two tables + enum + relations + index; `webhook-signing.ts` (catalog + sign/verify/generate); add `svix` to engine. User runs `db:generate`+`db:migrate`. | — |
| **S2 — Emit spine** | 2 | `outbound.ts` (`emitOutbound`, payloads); `resolveEmailSendContextByResendId`; widen `softDeleteContact`. | S1 (tables, catalog, signing) |
| **S3 — Delivery task** | 3 | `deliver-webhook.ts` (task + reaper); register in `worker.ts`. | S1 (tables, signing), S2 (`deliverWebhookTask` is enqueued by `emitOutbound` — but the task only READS the rows S2 writes, so S2 and S3 share only the row contract from S1; S3 depends on S1 + the `emitOutbound` enqueue name from S2) |
| **S4 — Emit hooks** | 4 | Wire `void emitOutbound(...)` into the 10 files at the 12 catalog points; suppress provider open/click echo; thread `hatchet` into tracked-mailer + mailer config. | S2 (`emitOutbound`), S3 (`deliverWebhookTask` registered so enqueues resolve at runtime) |
| **S5 — Admin routes + barrel + env** | 5 | `routes/admin/webhooks.ts` + mount; engine `index.ts` re-exports (signing, emit, presets, verify); `env.ts` (outbound tunables + 4 preset secrets + `ENABLED_WEBHOOK_PRESETS`). | S1 (tables, `generateWebhookSecret`), S3 (`deliverWebhookTask` for `/test`) |
| **S7 — Preset auth contract** | 5 | Widen `WebhookSourceAuth`/`WebhookSourceCtx`; `verifySignature`; raw-body in `sources.ts`. | S1 (svix dep present) — independent of S4/S5; runs in the SAME wall-clock window as S5 (different files) |
| **S8 — Presets + app wire** | 6 | 4 preset sources + `presets/index.ts`; `app.ts` merge + `enablePresets`; scaffold `env.example`. | S7 (auth contract), S5 (env keys + `presetsFromEnv` export are in env.ts/barrel) |
| **S6 — Client + CLI** | 6 | `hs.webhooks.*` resource + types + `patch`; `verifyHogsendWebhook`; `hogsend webhooks` command + `patch`/`del` on AdminClient. | S5 (admin route shapes locked — but shapes are in THIS doc, so S6 depends only on the route CONTRACT, can start once §1.8/1.9/1.10 are read; placed in group 6 to avoid touching engine files S5 owns) |
| **S9 — Tests** | 7 | All 5 test files. | S4, S5, S6, S8 |

Parallel-safe windows:
- **Group 1:** S1 alone (everything depends on it).
- **Group 2:** S2.
- **Group 3:** S3.
- **Group 4 (parallel):** S4. (Touches engine libs/routes; S5 and S7 do NOT touch the S4 files, so S4 ∥ S5 ∥ S7 is collision-free EXCEPT both S4 and S5 conceptually need `emitOutbound`/the task — both already landed in S2/S3. To be safe, run S4 in its own window, then S5+S7 together.)
- **Group 5 (parallel):** S5 ∥ S7 (disjoint file sets — admin/barrel/env vs webhook-sources contract/route).
- **Group 6 (parallel):** S6 ∥ S8 (client+CLI packages vs engine presets/app — disjoint).
- **Group 7:** S9 (tests, after all impl).

---

## 5. CONSOLIDATED INTERFACE QUICK-REFERENCE

```ts
// ── signing (engine/lib/webhook-signing.ts) ──
WEBHOOK_EVENT_TYPES: readonly [12 strings]
type WebhookEventType
generateWebhookSecret(): { secret: string; secretPrefix: string }
signWebhook(opts: { id: string; timestamp: number; payload: unknown; secret: string }): { headers: {...}; body: string }
verifyWebhookSignature(opts: { payload: string; headers: Record<string,string>; secret: string }): unknown

// ── emit (engine/lib/outbound.ts) ──
emitOutbound<E>(opts: { db; hatchet; logger; event: E; payload: OutboundPayloads[E]; dedupeKey?: string; organizationId?: string|null }): Promise<void>
resolveEmailSendContextByResendId(db, resendId): Promise<{ emailSendId; userId; userEmail; templateKey; to } | null>

// ── delivery (engine/workflows/deliver-webhook.ts) ──
deliverWebhookTask: hatchet.task<{ deliveryId: string }>  // retries:0, executionTimeout:"30s"
reapDueWebhookDeliveriesTask: hatchet.task  // onCrons:["*/1 * * * *"], retries:1

// ── admin routes (/v1/admin/webhooks) ──
GET / · POST / (201 +secret) · GET /{id} · PATCH /{id} · DELETE /{id} · POST /{id}/rotate-secret · POST /{id}/test (202)

// ── client ──
hs.webhooks: WebhooksResource  // requires full-admin key
verifyHogsendWebhook({ payload, headers, secret }): unknown

// ── presets auth (engine/webhook-sources/define-webhook-source.ts) ──
type WebhookSourceAuth = { type:"match"; header; envKey } | { type:"signature"; scheme:"svix"|"stripe"|"hmac-hex"; envKey; header; fallbackMatchHeader?; verify? }
verifySignature(scheme, { rawBody, headers, secret }): boolean
PRESET_SOURCES, presetsFromEnv(env), clerkSource, supabaseSource, stripeSource, segmentSource
CreateAppOptions.enablePresets?: boolean  // default true
```

---

## 6. DECISIONS TO CONFIRM (founder-level forks, deduplicated)

Each has a clear recommendation; the plan above assumes the recommendation unless overridden.

1. **Secret storage = PLAINTEXT recoverable** (vs hashed like api_keys, vs encrypted-at-rest/KMS). REQUIRED to HMAC-sign every delivery; matches Svix/Stripe/Loops. **Rec: plaintext now**, flag KMS/at-rest-encryption as a Phase-3 follow-up. Never log/return `secret` outside create+rotate.
2. **Endpoint-management auth plane = ADMIN** (`/v1/admin/webhooks`, `requireAdmin`) vs the `ingest` data plane. Signing-secret management is the same trust class as `api_keys`; a leaked ingest key must not register an exfiltration endpoint. **Rec: ADMIN plane.** Consequence: `hs.webhooks.*` needs a full-admin key (documented).
3. **`contact.created`/`updated` emit at the ROUTE/intent layer** (using `{created,linked,merged}` flags) NOT inside `resolveOrCreateContact`/`ingestEvent`. The single most important correctness call (avoids firing on every pageview). **Rec: route layer.** `contact.updated` fires only on a real property delta or a newly-attached identity.
4. **`email.opened`/`clicked` single emitter = first-party tracking** (gated on the existing null-timestamp first-touch UPDATE); the Resend provider-webhook echo is SUPPRESSED. **Rec: first-party for open/click; provider for sent/delivered/bounced.**
5. **Delivery model = row + 1-min reaper cron** (queryable, dead-letterable, orphan-recoverable; matches `reapStuckCampaignsTask`) vs an in-task durable sleep. **Rec: row+reaper.**
6. **Fan-out granularity = one row + one `runNoWait` per (event × endpoint)** vs one task looping all endpoints — independent retry/backoff/dead-letter per endpoint. **Rec: per-endpoint row.**
7. **Retry numbers**: MAX_ATTEMPTS **8**, exponential base 5s × 2^n + jitter capped 6h, timeout **15s**, persistent-4xx fast-fail after attempt ≥2. **Rec: as stated** (env-tunable).
8. **Dead path = `webhook_deliveries.status='failed'` + a forensic `dead_letter_queue` mirror** (`source="webhook-delivery"`). The live retry state lives on `webhook_deliveries`; the DLQ row is for the unified ops/Studio view. **Rec: yes, mirror on terminal `failed`.** (DLQ "retry" of a `webhook-delivery` source is observe-only for v1 — it flips status but does NOT re-enqueue; a re-enqueue is a Phase-3 follow-up.)
9. **Subscription model = flat `eventTypes` jsonb array** on the endpoint (filter at emit via `@>`) vs a normalized join table. **Rec: flat** (matches `apiKeys.scopes`). A GIN index on `event_types` is the documented upgrade path if endpoint counts grow.
10. **Rotate-secret = hard cutover** (old secret invalid immediately) vs a Svix dual-sign grace window. **Rec: hard cutover now**; add `previousSecret`+`secretRotatedAt` grace columns in Phase 3 if needed. (The delivery task reads the LIVE endpoint secret, so a rotate invalidates in-flight unsigned-yet deliveries — acceptable under at-least-once.)
11. **`webhook.test` = out-of-band** (delivered regardless of `eventTypes`, NOT a catalog member) vs a real catalog event. **Rec: out-of-band.**
12. **Ship `verifyHogsendWebhook()` in `@hogsend/client`** (the subscriber-side verify helper). **Rec: yes** — the "build ON Hogsend" completeness piece.
13. **Presets enablement = AUTO by env-secret presence** (`STRIPE_WEBHOOK_SECRET` set → Stripe on) with an `ENABLED_WEBHOOK_PRESETS` override + `enablePresets:false` escape hatch, AND explicit opt-in via `webhookSources: [stripeSource]`. **Rec: auto + override + explicit, all supported.**
14. **Stripe signature verify = `node:crypto`** (no `stripe` SDK dep) vs the SDK. **Rec: node:crypto** (keep the engine dependency-light; the scheme is ~15 lines).
15. **`user.deleted`/`customer.deleted` from presets = emit `contact.deleted` EVENT only** (no real soft-delete via `ingestEvent`). **Rec: event-only for Phase 2**; a soft-delete side-channel is deferred. (D-IP-DELETE)
16. **Preset event vocabulary = Hogsend-normalized** (`contact.created`, `subscription.updated`, `invoice.paid`) so it aligns with the outbound catalog + journey triggers. **Rec: normalized** (so an inbound Clerk `user.created` can fan out as outbound `contact.created`).
17. **`organizationId` single-tenant behavior** = column present + nullable everywhere, all rows `organizationId IS NULL`, `emitOutbound`/endpoint-select filter `organizationId IS NULL` (NOT a hardcoded tenant). **Rec: confirmed** — multi-tenant wiring is a later non-breaking change.

---

## 7. OPEN RISKS

1. **Missed emit point = silent gap.** The 12-point list in §1.6 is derived from grepping every `emitBucketTransition`/`upsertEmailPreference`/`resolveOrCreateContact`/`softDeleteContact`/`journey:completed`/`sendTrackedEmail`/tracking-route call site. A future write path bypassing these chokes (e.g. a new bulk-import) will NOT emit. `import-contacts.ts` is the known intentional non-emit. Document the choke points; a test asserts each fires.
2. **Hot-path blocking.** If `emitOutbound` is ever awaited un-`.catch()`'d on the ingest/send/journey path, a transient DB error selecting endpoints fails a contact upsert / email send / journey step. ALL call sites MUST be `void emitOutbound(...).catch(logger.warn)`. The `email.sent` site is load-bearing: it fires inside the `try` after the provider accepted the mail; an un-caught reject would bubble into the catch that re-marks the send `failed`. A review grep for un-`.catch()`'d `emitOutbound` is required.
3. **Double-delivery on Hatchet retry.** Bucket/journey/email-sent emits run inside durable tasks Hatchet may re-execute. The `dedupeKey` (`idempotencyKey`/`stateId`/`emailSendId`) + the unique `(endpointId, dedupeKey)` index is the ONLY producer-side guard. If that index is omitted, retries double-fire. Subscriber-side, the shared `Webhook-Id` (stable per logical event, reused across retries) is the dedup key — at-least-once, dedupable downstream.
4. **`email.opened`/`clicked` double-source.** Opens/clicks fire from BOTH the first-party pixel/redirect AND the Resend webhook. Without the first-touch null→set gate (first-party wins, provider echo suppressed), subscribers get duplicate `email.opened` with DIFFERENT `Webhook-Id`s (undedupable). The gate is load-bearing.
5. **Plaintext secrets at rest.** Anyone with DB read access can forge signed webhooks to all subscribers. Mitigate: never log/return `secret` outside create+rotate; flag KMS as Phase 3.
6. **Stripe signature fidelity.** Verification MUST run over the EXACT received bytes. If any upstream middleware (compress, body re-serialization) mutates the body before `c.req.text()`, Stripe/Svix verify fails. Confirm `c.req.text()` yields the untouched body and no middleware consumes it first.
7. **Signature presets fail-OPEN.** The existing `"match"` path treats an unconfigured secret as OPEN. Carrying that to `"signature"` would silently accept unsigned Stripe/Clerk traffic. Signature sources MUST fail CLOSED (401) when the secret is absent — a deliberate divergence, must be tested.
8. **Signed-body byte-stability.** The signature covers `JSON.stringify(payload)`; the SAME string must be signed AND sent. The delivery task computes `body` once and passes it to both `signWebhook` and `fetch` — never re-serialize between sign and send.
9. **`svix` becomes a direct engine dep** (currently transitive via plugin-resend). If plugin-resend drops it or versions diverge, signing/Clerk/Supabase verify break. Add `svix` as a direct, explicitly-versioned engine dependency.
10. **Env-schema completeness.** The route resolves preset secrets via `env[source.auth.envKey]`; forgetting to add the 4 keys to `env.ts` makes them invisible (always-unconfigured → fail-closed misbehavior for signature sources). The keys + `ENABLED_WEBHOOK_PRESETS` + outbound crons MUST land together (owned by S5).
11. **DLQ `sourceId` has no FK** to `webhook_endpoints`; a deleted endpoint (cascade) leaves orphan DLQ rows. The admin DLQ retry must tolerate a missing endpoint. Acceptable.
12. **Multi-tenant deferral is load-bearing.** `organizationId` is nullable + ignored now. Any query written assuming single-tenant (global endpoint list, unscoped secret) makes Phase-3 org-scoping a full revisit. Keep the nullable column from day one and filter `organizationId IS NULL` (not a hardcoded tenant) so the MT wiring is a non-breaking change.
13. **Cross-module column-name drift.** The 3 schema-touching modules proposed different column names. §1.1 is canonical; `deliver-webhook.ts`, `outbound.ts`, and `webhooks.ts` ALL reference the §1.1 names (`disabled`, `eventTypes`, `secret`/`secretPrefix`, `attemptCount`, `webhookId`, `dedupeKey`, status enum `pending|sending|delivered|failed|discarded`). Any deviation fails to compile — verify against §1.1 before S2/S3/S5 start.
14. **Contact-identity collisions across presets.** Clerk userId, Supabase uuid, Stripe customer id are DIFFERENT external ids for the same human; two enabled presets can mint two contacts. Out of scope for presets; document as a multi-preset hazard (alias/merge is Phase 3).
15. **Studio surface.** Outbound `webhook_endpoints`/`webhook_deliveries` and the DLQ mirror rows surface in the EXISTING admin DLQ screen with zero new UI; a dedicated Studio endpoints view is out of scope for this cut.
