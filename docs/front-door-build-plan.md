# Hogsend Front Door — Authoritative Build Plan

**Status:** locked · **Source of truth for all implementation agents.** Build SOLELY from this document plus the six locked decisions (D1–D6) and DESTRUCTIVE LATITUDE. Where this plan and a designer's module JSON disagree, **this plan wins** — the disagreements are reconciled in §1.

This plan reconciles 7 module designs into ONE conflict-free build. Every file touched is owned by exactly one execution stage (§3), so stages in the same parallel group never collide. The interface contract (§2) is the locked cross-module surface — implement to these signatures exactly.

---

## 0. Locked decisions (recap, design to these)

- **D1 IDENTITY** — canonical `contacts.id` (uuid) stays. `external_id` → NULLABLE; `email` is a resolvable identity key (unique partial index on `lower(email)` where not null & not deleted). API accepts `{ userId }` (=external_id), `{ email }`, or both. Future anonymous→identified supported via `anonymous_id`. Build a REAL `resolveOrCreateContact` with merge/alias now. Store NORMALIZED RAW email. `email_hash` DEFERRED.
- **D2 PROPERTY SPLIT** — explicit `contactProperties` (→ `contacts.properties`) vs `eventProperties` (→ `user_events` + Hatchet `trigger.where`/`exitOn` ONLY). Behavior change to `ingestEvent`; every IngestEvent construction site updated.
- **D3 LISTS** — code-defined `defineList({id,name,defaultOptIn})` + `ListRegistry`, membership in existing `email_preferences.categories` JSONB. No new tables.
- **D4 POSTHOG** — optional enrichment + opt-in mirror, never required. No hard read dependency. Mirror-only.
- **D5 SCOPE** — new orthogonal `ingest` data-plane scope (full-admin implies ingest). `requireApiKey + requireScope('ingest')` on all new data-plane routes AND the retrofit of `/v1/ingest`. Per-key rate limit on `/v1/emails`.
- **D6 NAMING** — new package `@hogsend/client`. `hogsend` bin stays `@hogsend/cli`.
- **DESTRUCTIVE LATITUDE** — ~3-4 users; no back-compat shims. Replace `/v1/ingest` shape outright (delete the old router). Keep what's still used: admin observe, tracking, journeys, buckets, mailer, Studio Debug.

---

## 1. Reconciled interface disagreements

The 7 designers assumed slightly different names/signatures/return-shapes for shared surfaces. Each is resolved below; the canonical form is locked in §2.

1. **`resolveOrCreateContact` return shape.** Identity module returns `{ id, created, linked, merged }`; routes/lists/cleanup modules assume `{ id, created, linked }` (no `merged`). **RESOLVED:** return `{ id, created, linked, merged }`. `merged` is additive — callers that ignore it still compile. Routes destructure only `{ id, created, linked }`.

2. **`resolveOrCreateContact` param name for external id.** Spec §3.1 + routes use `userId`; identity wrapper `upsertContact` uses `externalId`. **RESOLVED:** `resolveOrCreateContact` takes `userId` (maps to `external_id`). The retained `upsertContact` wrapper takes `externalId` and forwards to `userId`. Both keep `contactProperties` as the property param (NOT `properties`).

3. **`IngestEvent.userId` optionality + property field.** Old shape: `{ event, userId, userEmail, properties }`. **RESOLVED canonical:** `{ event, userId?, userEmail?, anonymousId?, eventProperties, contactProperties?, idempotencyKey? }`. `eventProperties` is REQUIRED (default `{}` at construction sites); `properties` is DELETED (no compat).

4. **`anonymousId` on IngestEvent.** Identity module wants it; ingestion/routes modules omit it. **RESOLVED:** include `anonymousId?` on `IngestEvent` and thread it through `ingestEvent → resolveOrCreateContact`. Public `/v1/events` + `/v1/contacts` do NOT expose `anonymousId` in phase 1 (no body field) — it exists on the type for the future anon path and internal callers. This keeps the anonymous→identified machinery wired without widening the public API yet.

5. **`checkBucketMembership` property param.** Old: single `properties`. Ingestion module wants `{ eventProperties, contactProperties }`. **RESOLVED:** replace `properties` with `eventProperties` (candidate narrowing) + `contactProperties?` (overlay on the read contact row). The raw event payload NO LONGER participates in property eval.

6. **`checkBucketMembership` contact read key (D1 coupling).** Today reads `eq(contacts.externalId, userId)`. With email-only/anon contacts this misses. **RESOLVED:** `ingestEvent` resolves identity FIRST via `resolveOrCreateContact`, then passes the **canonical resolved string key** (the `external_id` when present, else `anonymous_id`, else the contact `id`) as `userId` to everything downstream (user_events, Hatchet, checkExits, checkBucketMembership). `checkBucketMembership` keeps an `externalId` lookup but is fed the resolved key; the overlay of this-ingest's `contactProperties` covers the read-after-write gap. Switching the lookup to `contactWhereClause` is an allowed enhancement but NOT required for phase 1.

7. **Rate-limit middleware shape.** Auth module wants `createRateLimit({windowMs,max,prefix})` factory + keep `rateLimit` export. Routes module just imports `rateLimit`. **RESOLVED:** add the `createRateLimit` factory, keep `export const rateLimit = createRateLimit()` (100/60s, prefix `"ratelimit"`). `/v1/emails` uses `createRateLimit({ prefix: "ratelimit:emails", max: <conservative> })`. Add `Retry-After` header on 429 (the SDK maps it to `RateLimitError.retryAfter`).

8. **`requireScope` semantics.** Today `SCOPE_HIERARCHY["ingest"] ?? 0` → ANY authenticated key passes (latent bug, confirmed in source lines 110-128). **RESOLVED:** introduce `hasScope(keyScopes, required)` as the single source of truth: hierarchical scopes use max-of-key ≥ required; orthogonal `ingest` requires explicit grant OR `full-admin`. `requireScope` delegates to `hasScope`. Export `hasScope`.

9. **`upsertEmailPreference` / `setListMembership` shared helper.** Lists module proposes a new object-arg helper in `lib/contacts.ts` or `lib/preferences.ts`; the real existing helper is `upsertPreference(db, externalId, email, update)` (positional) **private in `routes/email/unsubscribe.ts`**. **RESOLVED:** extract the existing `upsertPreference` body into a new shared module **`packages/engine/src/lib/preferences.ts`** as `upsertEmailPreference({ db, externalId, email, update })` (object-arg). `unsubscribe.ts` imports it (one-line refactor). Lists subscribe/unsubscribe + `applyListMembership` reuse it. Single source of truth for the `(userId,email)` onConflict + `jsonb_set` write.

10. **`applyListMembership` signature.** Routes module calls `applyListMembership({ db, contactId?, userId?, email?, lists })`. **RESOLVED canonical:** `applyListMembership({ db, userId?, email?, lists })` lives in **`lib/preferences.ts`**. It resolves the `(externalId, email)` pair it needs (via `resolveOrCreateContact` having already run, then reading back identity) and calls `upsertEmailPreference` per list key. `contactId` is NOT a param (the prefs table keys on `userId`+`email`, not `contacts.id`).

11. **email_preferences keying for email-only contacts.** `email_preferences` PK is `(user_id NOT NULL, email NOT NULL)` where `user_id == external_id`. D1 allows email-only contacts (external_id NULL). **RESOLVED (phase 1, no schema change):** list/preference writes REQUIRE an email (reject userId-only-with-no-email with 400 "Contact has no email; cannot manage list membership"). For the `user_id` column, use the resolved `external_id` when present, else the **contact `id` (uuid string)** as the deterministic fallback. This same fallback MUST be used consistently across subscribe writes, preference-center reads, and unsubscribe-token issuance. `resolveRecipient` (below) returns both so callers never improvise.

12. **`resolveRecipient` for `/v1/emails`.** Routes module assumes `resolveRecipient({ db, userId }): { email, userId? } | null`. **RESOLVED canonical:** `resolveRecipient({ db, userId?, email? }): Promise<{ email: string; externalId: string | null; contactId: string } | null>` in `lib/contacts.ts`. Returns null when no resolvable email. `/v1/emails` uses `email` for the send and `externalId ?? contactId` for the denormalized `userId` on the send row.

13. **`ctx.trigger` public param naming.** Three designers flag the conflict: renaming `TriggerOptions.properties` → `eventProperties` breaks consumer journeys (reactivation-dormancy, test-onboarding) + scaffold. **RESOLVED:** KEEP the public `TriggerOptions.properties` field name; map it INTERNALLY to `eventProperties` (no `contactProperties` by default). Consumer journey files + scaffold + their tests need NO change. (A future `contactProperties` on `TriggerOptions` is deferred.)

14. **Admin enroll / bulk request field name.** `properties` on the enroll/batch-enroll request body. **RESOLVED:** KEEP the public request field name `properties`; map it to `eventProperties` inside the handler's IngestEvent construction. `admin-journeys.test.ts` enroll request stays valid.

15. **`/v1/ingest` fate.** Auth + routes + cleanup modules all converge: DELETE `routes/ingest.ts` outright, `POST /v1/events` is the replacement. **RESOLVED:** delete the file, no shim. The Studio Debug sender (`packages/studio/src/lib/admin-api.ts:559`) is the ONLY live caller of the old shape and MUST be repointed to `POST /v1/events` before/with the deletion.

16. **Data-plane mount style.** Two phrasings: per-router auth vs a shared guarded sub-app. **RESOLVED:** one guarded `dataPlane` sub-app in `routes/index.ts` applies `requireApiKey` then `requireScope("ingest")` for all of `/v1/contacts`, `/v1/events`, `/v1/emails`, `/v1/lists`; `/v1/emails/*` layers the per-key email rate-limit on top. The lists router does NOT re-apply auth internally (avoid double middleware) — it relies on the sub-app guard. (Designer sketches that put `use('*', requireApiKey...)` inside the lists router are superseded: auth lives only at the sub-app.)

17. **`@hogsend/client` HTTP core sharing.** SDK module ports a self-contained core into `client/src/internal/http.ts` (NOT a shared package); CLI keeps its own `lib/http.ts`. **RESOLVED:** accept this — no shared `@hogsend/http-core` package in phase 1 (conflict-safe for parallel work). The CLI gets a second `createDataPlaneClient(cfg)` factory inside its existing `lib/http.ts`, reusing its private `request()`. The two cores stay independent.

18. **contacts admin response schema.** `contactSchema.externalId` is `z.string()` (non-nullable). D1 makes it nullable. **RESOLVED:** change admin `contactSchema.externalId` and `serializeContact` to `.nullable()` (and add `anonymousId: string | null` where the admin serializer is touched). Owned by the routes stage that touches admin/contacts.ts.

19. **`email_hash` column.** Identity module proposes a deferred stub. **RESOLVED:** DEFER fully — do NOT add the column or any commented stub in phase 1 (the spec defers it; adding a commented stub is noise). Flagged in openRisks for a GDPR follow-up.

20. **Survivor rule + merge ordering.** Only the identity module specifies these; no conflict, but they are LOCKED as part of the contract (§2.1) so the routes/cleanup stages that call the resolver rely on a deterministic outcome.

---

## 2. Interface contract (LOCKED — implement to these exactly)

### 2.1 Identity — `packages/engine/src/lib/contacts.ts` + `lib/preferences.ts`

```ts
// Normalized, sendable email. trim + toLowerCase. No dot/+tag stripping.
export function normalizeEmail(raw: string): string;

// THE resolver. Transactional (db.transaction). Handles:
//   create (any combo of keys, incl. anon-only / email-only / ext-only),
//   fill-in-link (single row, missing keys filled, 'promote' alias recorded),
//   collide-MERGE (2-3 distinct rows -> survivor + losers re-pointed/soft-deleted/aliased).
// Consults contact_aliases on a miss so a stale (loser) key resolves to the survivor.
export async function resolveOrCreateContact(opts: {
  db: Database;
  userId?: string;        // external_id
  email?: string;         // normalized internally
  anonymousId?: string;   // stable anon/distinct id
  contactProperties?: Record<string, unknown>;  // merged: COALESCE(properties,'{}') || patch; explicit null clears a key
}): Promise<{ id: string; created: boolean; linked: boolean; merged: boolean }>;

// Retained thin wrapper so existing callers compile. externalId now OPTIONAL.
export async function upsertContact(opts: {
  db: Database;
  externalId?: string;
  email?: string;
  anonymousId?: string;
  properties?: Record<string, unknown>;  // forwarded as contactProperties
}): Promise<{ id: string; created: boolean; linked: boolean; merged: boolean }>;

// Public-route helpers (D1 module owns these; routes/lists consume them).
export async function findContacts(opts: { db: Database; email?: string; userId?: string }):
  Promise<typeof contacts.$inferSelect[]>;  // non-deleted only
export async function softDeleteContact(opts: { db: Database; email?: string; userId?: string }):
  Promise<boolean>;  // true iff a row was soft-deleted
export async function resolveRecipient(opts: { db: Database; userId?: string; email?: string }):
  Promise<{ email: string; externalId: string | null; contactId: string } | null>;

// UNCHANGED, keep: contactWhereClause, resolveContact, serializePrefs, contactSearchFilter
// (contactSearchFilter MAY also search anonymousId — minor, optional).
```

**SURVIVOR RULE (deterministic):** prefer the row owning an `external_id` (identified > anonymous) → tie-break OLDEST `firstSeenAt` → final tie-break lowest `id`.

**MERGE re-point order (all in one tx):** (i) compute loser string keys `[loser.externalId, loser.anonymousId]` and target `survivor.externalId ?? survivor.anonymousId ?? survivor.id`; (ii) `user_events.user_id` rewrite; (iii) `journey_states` — first EXIT the loser's duplicate active row if survivor+loser both active in same journey (respect `uq_user_journey_active`), then rewrite `user_id`/`user_email`; (iv) `email_sends` rewrite `user_id` (+ `userEmail` to survivor's); (v) `bucket_memberships` — first soft-LEAVE the loser's duplicate active membership if both active in same bucket (respect `uq_user_bucket_active`, preserve survivor's dwell clock), then rewrite; (vi) `email_preferences` FOLD (don't blind-rewrite): `unsubscribedAll`=OR, `suppressed`=OR, `bounceCount`=MAX, `categories`= merge with FALSE winning on conflict (unsub never lost), `suppressedAt`/`lastBounceAt`= earliest non-null; (vii) FOLD properties: `survivor.properties = COALESCE(loser,'{}') || COALESCE(survivor,'{}')` (survivor wins), then apply call's `contactProperties` (call wins last); `timezone = survivor ?? loser`; `firstSeenAt = least`; (viii) **soft-delete loser FIRST**, THEN copy any keys the loser owned onto the survivor (ordering matters: partial-unique indexes are `WHERE deleted_at IS NULL`); (ix) RECORD `contact_aliases` rows for each loser key (`reason:'merge'`, `fromContactId: loser.id`).

**INSERT RACE mitigation:** `pg_advisory_xact_lock(hashtext(kind||value))` per provided key at the TOP of the tx (before SELECTs) OR catch unique-violation and retry-as-found. Document the chosen strategy in code.

```ts
// packages/engine/src/lib/preferences.ts (NEW — extracted from unsubscribe.ts)
export async function upsertEmailPreference(opts: {
  db: Database;
  externalId: string;   // user_id column value (= external_id, or contact.id fallback for email-only)
  email: string;        // REQUIRED (NOT NULL column)
  update: { unsubscribedAll?: boolean; suppressed?: boolean; categoryKey?: string; categoryValue?: boolean };
}): Promise<void>;

// D3 helper. Resolves identity to (externalId|contactId fallback, email), then
// upsertEmailPreference per list key. Requires a resolvable email (400 upstream if none).
export async function applyListMembership(opts: {
  db: Database; userId?: string; email?: string; lists: Record<string, boolean>;
}): Promise<void>;
```

### 2.2 Ingestion — `packages/engine/src/lib/ingestion.ts`

```ts
export interface IngestEvent {
  event: string;
  userId?: string;                              // D1: optional (email-only / anon)
  userEmail?: string;
  anonymousId?: string;                         // D1: future anon path
  eventProperties: Record<string, unknown>;     // -> user_events + Hatchet trigger.where/exitOn ONLY
  contactProperties?: Record<string, unknown>;  // -> contacts.properties merge ONLY
  idempotencyKey?: string;
}
// `properties` is DELETED.

export interface ExitResult { journeyId: string; stateId: string; exited: boolean; }
export interface IngestResult { stored: boolean; exits: ExitResult[]; }

export async function ingestEvent(opts: {
  db: Database; registry: JourneyRegistry; hatchet: HatchetClient; logger: Logger;
  event: IngestEvent;
}): Promise<IngestResult>;
```

**`ingestEvent` body order (LOCKED):** (1) `resolveOrCreateContact({ db, userId, email: userEmail, anonymousId, contactProperties })` AWAITED FIRST (no longer fire-and-forget) → derive `resolvedKey = external_id ?? anonymous_id ?? contact.id`; (2) idempotency dedup + insert `user_events` with `userId: resolvedKey`, `properties: eventProperties`; (3) build `serializableProperties` from `eventProperties`; (4) Hatchet push with `userId: resolvedKey`, `userEmail: userEmail ?? ''`, `properties: serializableProperties`; (5) `checkExits` with `userId: resolvedKey`, `properties: eventProperties`; (6) `checkBucketMembership` with `userId: resolvedKey`, `eventProperties`, `contactProperties: contactProperties ?? {}`, `userEmail: userEmail || null`. The Hatchet push payload key STAYS `properties` (bucket tests assert on it — do NOT rename the wire key).

### 2.3 Buckets — `packages/engine/src/buckets/check-membership.ts`

```ts
export async function checkBucketMembership(opts: {
  db: Database; registry: JourneyRegistry; hatchet: HatchetClient; logger: Logger;
  userId: string; userEmail: string | null; event: string;
  eventProperties: Record<string, unknown>;        // REPLACES `properties` — candidate narrowing only
  contactProperties?: Record<string, unknown>;     // this-ingest patch, overlaid on the read contact row
  bucketRegistry?: ReturnType<typeof getBucketRegistrySingleton>;
}): Promise<BucketTransition[]>;
```
- Candidate narrowing iterates keys of BOTH `eventProperties` and `contactProperties`.
- Eval context = `{ ...storedContactPropsFromDbRow, ...(contactProperties ?? {}) }`. **The raw event payload is REMOVED** from the property-eval context. Event/count sub-conditions (`check:'exists'`) read `userEvents` directly — unaffected.

### 2.4 Auth — `packages/engine/src/middleware/api-key.ts` + `rate-limit.ts`

```ts
export function hasScope(keyScopes: string[], required: string): boolean;
// hierarchical (read<journey-admin<full-admin): max-of-key >= required
// orthogonal (ingest): keyScopes.includes(required) || keyScopes.includes("full-admin")

export function requireScope(scope: string): MiddlewareHandler<AppEnv>;  // delegates to hasScope
// requireApiKey unchanged. Legacy ADMIN_API_KEY keeps scopes:["full-admin"] -> implies ingest.

export interface RateLimitOptions { windowMs?: number; max?: number; prefix?: string; }
export function createRateLimit(opts?: RateLimitOptions): MiddlewareHandler<AppEnv>;
export const rateLimit: MiddlewareHandler<AppEnv>;  // = createRateLimit() (100/60s, prefix "ratelimit")
// 429 responses set a Retry-After header.

// api-keys create scopes enum gains "ingest":
//   z.array(z.enum(["read","journey-admin","full-admin","ingest"])).min(1).default(["read"])
```

### 2.5 Public data-plane routes (D1/D2/D5)

All under the guarded `dataPlane` sub-app (`requireApiKey` + `requireScope("ingest")`); `/v1/emails/*` additionally rate-limited per-key.

```
PUT    /v1/contacts        body { email?, userId?, properties?, lists? }  (email|userId req)
                           -> 200 { id, created, linked } | 400
GET    /v1/contacts/find   ?email= | ?userId=  (one req)
                           -> 200 { contacts: Contact[] } | 400
DELETE /v1/contacts        body { email?, userId? }  (one req)
                           -> 200 { deleted: true } | 404 | 400   (soft delete)

POST   /v1/events          body { name, email?, userId?, eventProperties?, contactProperties?,
                                  lists?, idempotencyKey?, timestamp? }  (email|userId req)
                           honors Idempotency-Key header (header wins over body field)
                           -> 202 { stored, exits: { journeyId, stateId, exited }[] } | 400

POST   /v1/emails          body { to?, userId?, template, props?, from?, subject?, replyTo?,
                                  category?, skipPreferenceCheck?, idempotencyKey? }  (to|userId req)
                           -> 202 { emailSendId, status: "queued"|"sent"|"suppressed"|"unsubscribed"|"skipped", reason? }
                           | 400 (missing recipient / unknown template) | 403 (skipPreferenceCheck w/o full-admin)
                           | 404 (userId has no resolvable email)

GET    /v1/lists           -> 200 { lists: { id, name, description?, defaultOptIn }[] }
POST   /v1/lists/:id/subscribe     body { email?, userId? }  -> 200 { list, subscribed: true } | 404 | 400
POST   /v1/lists/:id/unsubscribe   body { email?, userId? }  -> 200 { list, subscribed: false } | 404 | 400
```

`Contact` serialized shape (admin + data plane): `{ id, externalId: string|null, email: string|null, properties, firstSeenAt, lastSeenAt, createdAt, updatedAt }` (timestamps ISO). `/v1/emails` maps to `EmailService.send` **journeyless** (omit `journeyStateId`) so §5 tracking runs. `skipPreferenceCheck` gated via `hasScope(apiKey.scopes, "full-admin")`. Template validated server-side against `getTemplateNames(container.templates)`.

**Lists ordering:** `/v1/contacts` and `/v1/events` apply `lists` AFTER the resolve/ingest so the contact exists; `applyListMembership` writes `email_preferences` independently of `contacts` (own table) so it does not race the contacts row.

### 2.6 Lists (D3)

```ts
export function defineList<const Id extends string>(meta: {
  id: Id; name: string; description?: string; defaultOptIn: boolean; enabled?: boolean;
}): DefinedList<Id>;
// id validated /^[a-z0-9_-]+$/i AND rejected if it collides with a reserved category ("transactional", "journey").

export interface ListMeta<Id extends string = string> {
  id: Id; name: string; description?: string; defaultOptIn: boolean; enabled: boolean;
}
export interface DefinedList<Id extends string = string> { readonly meta: ListMeta<Id>; readonly id: Id; }

export class ListRegistry {
  register(list: ListMeta): void; get(id: string): ListMeta | undefined;
  getAll(): ListMeta[]; getEnabled(): ListMeta[]; has(id: string): boolean; count(): number;
  isSubscribedByDefault(id: string): boolean;   // = get(id)?.defaultOptIn ?? true
  // Single source of truth for polarity, consumed by mailer + preference center:
  isSubscribed(categories: Record<string, boolean>, id: string): boolean;
  //   = defaultOptIn ? categories[id] !== false : categories[id] === true
}
export function buildListRegistry(lists: DefinedList[], enabledFilter?: string): ListRegistry;
// installs the process singleton.

export function getListRegistry(): ListRegistry;   // empty-default (never throws); unknown id -> legacy opt-in
export function setListRegistry(r: ListRegistry): void;
export function resetListRegistry(): void;
```

**Polarity reconciliation (LOCKED, the heart of D3).** `checkSuppression` (`lib/tracked.ts`) currently blocks a category only on `=== false`. Replace with: `const list = getListRegistry().get(category); const defaultOptIn = list?.defaultOptIn ?? true; block when defaultOptIn ? categories[category] === false : categories[category] !== true;`. Non-list categories (`transactional`, `journey`) resolve to `defaultOptIn true` → identical to today (block only on explicit false). The preference-center render uses the SAME `ListRegistry.isSubscribed` rule.

`HogsendClientOptions` gains `lists?: DefinedList[]` and `enabledLists?: string`; `HogsendClient` gains `listRegistry: ListRegistry`. `env.ENABLED_LISTS` (default `'*'`).

### 2.7 `@hogsend/client` (D6)

```ts
new Hogsend(opts: { baseUrl: string; apiKey: string; fetch?: typeof fetch; timeoutMs?: number; headers?: Record<string,string> });
//   .contacts.upsert(Identity & { properties?, lists? }) -> { id, created, linked }
//   .contacts.find({ email } | { userId }) -> Contact[]
//   .contacts.delete(Identity) -> { deleted: boolean }
//   .events.send(Identity & { name, eventProperties?, contactProperties?, lists?, idempotencyKey? }) -> IngestResult
//   .events.track = alias of send
//   .emails.send(SendEmailInput) -> { emailSendId: string; status: string }
//   .lists.list() -> ListSummary[]
//   .lists.subscribe({ list } & Identity) -> { subscribed: boolean }
//   .lists.unsubscribe({ list } & Identity) -> { unsubscribed: boolean }

type Identity = { email: string; userId?: string } | { email?: string; userId: string };  // >=1 key, assertIdentity at runtime
class HogsendAPIError extends Error { readonly status: number; readonly body: unknown }  // status 0 = transport
class RateLimitError extends HogsendAPIError { readonly retryAfter?: number }  // status 429
```
`@hogsend/email` is a TYPE-ONLY optional peer; `emails.send` is typed against the augmented `TemplateRegistryMap`, degrading to `template: string` + permissive `props` when un-augmented. Ships compiled dist (ESM + CJS + dts) via tsup. Starts at the engine version-line; **first publish MANUAL**.

### 2.8 CLI write commands (D6)

```ts
// packages/cli/src/lib/config.ts
interface ResolvedConfig { baseUrl: string; adminKey: string | undefined; dataKey: string | undefined; }
// dataKey precedence: --data-key > HOGSEND_DATA_KEY > HOGSEND_API_KEY (env then .env)

// packages/cli/src/lib/http.ts (ADD, reuse private request())
function createDataPlaneClient(cfg: ResolvedConfig): { get, post, put, del };  // bound to cfg.dataKey
```
New write surface: `hogsend contacts upsert`, `hogsend events send` (bare `events <userId>` STAYS the read path — regression-guarded), `hogsend emails send`. `CommandContext` gains `dataHttp`.

---

## 3. File ownership (every file → exactly ONE stage)

Stages with the same `parallelGroup` number AND disjoint files run in parallel. Ownership is grouped by directory boundary so parallel stages never touch the same file.

| File | Owner stage | Action |
|---|---|---|
| `packages/db/src/schema/contacts.ts` | S1-db | modify |
| `packages/db/src/schema/contact-aliases.ts` | S1-db | create |
| `packages/db/src/schema/relations.ts` | S1-db | modify |
| `packages/db/src/schema/index.ts` | S1-db | modify |
| `packages/engine/src/middleware/api-key.ts` | S2-auth | modify |
| `packages/engine/src/middleware/rate-limit.ts` | S2-auth | modify |
| `packages/engine/src/lib/contacts.ts` | S3-identity | modify |
| `packages/engine/src/lib/preferences.ts` | S3-identity | create |
| `packages/engine/src/lib/ingestion.ts` | S4-ingest | modify |
| `packages/engine/src/buckets/check-membership.ts` | S4-ingest | modify |
| `packages/engine/src/lib/bucket-emit.ts` | S4-ingest | modify |
| `packages/engine/src/lib/tracking-events.ts` | S4-ingest | modify |
| `packages/engine/src/journeys/journey-context.ts` | S4-ingest | modify |
| `packages/engine/src/lists/define-list.ts` | S5-lists-core | create |
| `packages/engine/src/lists/registry.ts` | S5-lists-core | create |
| `packages/engine/src/lists/registry-singleton.ts` | S5-lists-core | create |
| `packages/engine/src/lib/tracked.ts` | S5-lists-core | modify |
| `packages/engine/src/env.ts` | S5-lists-core | modify |
| `packages/engine/src/routes/contacts/index.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/events/index.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/emails/index.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/lists/index.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/lists/list.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/lists/subscribe.ts` | S6-routes-dataplane | create |
| `packages/engine/src/routes/ingest.ts` | S6-routes-dataplane | delete |
| `packages/engine/src/routes/email/unsubscribe.ts` | S6-routes-dataplane | modify |
| `packages/engine/src/routes/email/preferences.ts` | S6-routes-dataplane | modify |
| `packages/engine/src/routes/admin/contacts.ts` | S7-routes-admin | modify |
| `packages/engine/src/routes/admin/journeys.ts` | S7-routes-admin | modify |
| `packages/engine/src/routes/admin/bulk.ts` | S7-routes-admin | modify |
| `packages/engine/src/routes/admin/api-keys.ts` | S7-routes-admin | modify |
| `packages/engine/src/workflows/import-contacts.ts` | S7-routes-admin | modify |
| `packages/engine/src/routes/index.ts` | S8-wire | modify |
| `packages/engine/src/container.ts` | S8-wire | modify |
| `packages/engine/src/index.ts` | S8-wire | modify |
| `packages/client/package.json` | S9-client | create |
| `packages/client/tsup.config.ts` | S9-client | create |
| `packages/client/tsconfig.json` | S9-client | create |
| `packages/client/src/index.ts` | S9-client | create |
| `packages/client/src/hogsend.ts` | S9-client | create |
| `packages/client/src/errors.ts` | S9-client | create |
| `packages/client/src/types.ts` | S9-client | create |
| `packages/client/src/internal/http.ts` | S9-client | create |
| `packages/client/src/internal/identity.ts` | S9-client | create |
| `packages/client/src/resources/contacts.ts` | S9-client | create |
| `packages/client/src/resources/events.ts` | S9-client | create |
| `packages/client/src/resources/emails.ts` | S9-client | create |
| `packages/client/src/resources/lists.ts` | S9-client | create |
| `packages/client/README.md` | S9-client | create |
| `packages/client/src/__tests__/hogsend.test.ts` | S9-client | create |
| `packages/cli/src/lib/config.ts` | S10-cli | modify |
| `packages/cli/src/lib/http.ts` | S10-cli | modify |
| `packages/cli/src/commands/types.ts` | S10-cli | modify |
| `packages/cli/src/bin.ts` | S10-cli | modify |
| `packages/cli/src/commands/contacts.ts` | S10-cli | modify |
| `packages/cli/src/commands/events.ts` | S10-cli | modify |
| `packages/cli/src/commands/emails.ts` | S10-cli | create |
| `packages/cli/src/commands/index.ts` | S10-cli | modify |
| `packages/studio/src/lib/admin-api.ts` | S11-studio | modify |
| `apps/api/src/index.ts` | S12-consumer | modify |
| `apps/api/src/worker.ts` | S12-consumer | modify |
| `apps/api/src/webhook-sources/posthog.ts` | S12-consumer | modify |
| `apps/api/src/lists/index.ts` | S12-consumer | create |
| `packages/create-hogsend/template/src/index.ts` | S13-scaffold | modify |
| `packages/create-hogsend/template/src/worker.ts` | S13-scaffold | modify |
| `packages/create-hogsend/template/src/webhook-sources/posthog.ts` | S13-scaffold | modify |
| `packages/create-hogsend/template/src/lists/index.ts` | S13-scaffold | create |
| `packages/create-hogsend/template/src/lib/hogsend.ts` | S13-scaffold | create |
| `packages/create-hogsend/template/scripts/bootstrap.ts` | S13-scaffold | modify |
| `packages/create-hogsend/template/_package.json` | S13-scaffold | modify |
| `packages/create-hogsend/template/env.example` | S13-scaffold | modify |
| `packages/create-hogsend/template/README.md` | S13-scaffold | modify |
| `packages/create-hogsend/src/template-manifest.ts` | S13-scaffold | modify |
| `apps/api/src/__tests__/webhook-sources.test.ts` | S14-tests | modify |
| `apps/api/src/__tests__/buckets.test.ts` | S14-tests | modify |
| `apps/api/src/__tests__/admin-journeys.test.ts` | S14-tests | modify |
| `apps/api/scripts/smoke.ts` | S14-tests | modify |
| `apps/api/src/__tests__/contacts-dataplane.test.ts` | S14-tests | create |
| `apps/api/src/__tests__/events-dataplane.test.ts` | S14-tests | create |
| `apps/api/src/__tests__/emails-dataplane.test.ts` | S14-tests | create |
| `apps/api/src/__tests__/lists-dataplane.test.ts` | S14-tests | create |
| `apps/api/src/__tests__/auth-scope.test.ts` | S14-tests | create |
| `apps/api/src/__tests__/identity-merge.test.ts` | S14-tests | create |

> Note: `apps/api/src/journeys/test-onboarding.ts`, `reactivation-dormancy.ts`, and the scaffold `test-onboarding.ts` need NO changes (decision #13: `TriggerOptions.properties` public name kept). They are verification touch-points only, NOT owned by any stage.

---

## 4. Execution stages (ordered, with parallel groups)

Dependency spine: **db schema → engine identity/auth core → ingestion → lists-core → routes → wire → consumer**. The SDK/CLI/scaffold depend only on the LOCKED HTTP contract (§2.5/§2.7) and parallelize early. Tests land last.

### parallelGroup 1 (start together — disjoint files, no cross-deps)
- **S1-db** — DB schema. `contacts.externalId` nullable + drop inline `.unique()`; add partial-unique indexes on `external_id`, `lower(email)`, `anonymous_id` (each `WHERE col IS NOT NULL AND deleted_at IS NULL`); add `anonymous_id` column; keep plain `contacts_email_idx`. Create `contact_aliases` table + relations + `schema/index.ts` export. Run `cd packages/db && pnpm db:generate` — verify it emits partial-unique on `lower(email)` (functional index); if the generator can't express it, fall back to a `email_normalized` generated column + plain partial-unique. NO `email_hash` column. _dependsOn: none._
- **S2-auth** — `hasScope` + `requireScope` rewrite; `createRateLimit` factory + `rateLimit` default + `Retry-After`. _dependsOn: none._
- **S9-client** — `@hogsend/client` package (all of `packages/client/`). Build to ESM+CJS+dts. Builds against the LOCKED §2.5/§2.7 contract only. _dependsOn: §2 contract (frozen here)._
- **S10-cli** — CLI `config.ts` dataKey + `http.ts` `createDataPlaneClient` + `events send`/`contacts upsert`/`emails send` write commands + `commands/types.ts`/`bin.ts`/`index.ts`. Preserve bare `events <userId>` read path. _dependsOn: §2.5/§2.8 contract._

### parallelGroup 2
- **S3-identity** — `lib/contacts.ts`: `normalizeEmail`, `resolveOrCreateContact` (full merge/alias/anon per §2.1), retained `upsertContact` wrapper, `findContacts`, `softDeleteContact`, `resolveRecipient`. New `lib/preferences.ts`: `upsertEmailPreference` + `applyListMembership`. _dependsOn: S1-db (contact_aliases, nullable external_id, anonymous_id, partial indexes)._

### parallelGroup 3
- **S4-ingest** — `lib/ingestion.ts` (IngestEvent shape + `ingestEvent` body order per §2.2), `buckets/check-membership.ts` (§2.3), `lib/bucket-emit.ts` (two literals → `eventProperties`, no contactProperties), `lib/tracking-events.ts` (→ `eventProperties`), `journeys/journey-context.ts` (`ctx.trigger` maps public `properties` → `eventProperties` internally; keep public param). _dependsOn: S3-identity (resolveOrCreateContact + resolved-key)._
- **S5-lists-core** — `lists/define-list.ts`, `lists/registry.ts`, `lists/registry-singleton.ts` (empty-default), `lib/tracked.ts` `checkSuppression` polarity (§2.6), `env.ts` `ENABLED_LISTS`. _dependsOn: S2-auth not required; only needs the registry pattern. Can run in group 2 if scheduler prefers, but `tracked.ts`'s polarity change is independent of identity so group 3 keeps it off the contacts.ts file lane. (Disjoint from S4-ingest files.)_

### parallelGroup 4
- **S6-routes-dataplane** — new `routes/contacts/`, `routes/events/`, `routes/emails/`, `routes/lists/*`; DELETE `routes/ingest.ts`; refactor `routes/email/unsubscribe.ts` to import `upsertEmailPreference`; `routes/email/preferences.ts` registry-driven render. _dependsOn: S3-identity (resolver/helpers), S4-ingest (ingestEvent shape), S5-lists-core (ListRegistry + preferences). S2-auth (requireScope) for the mount but auth is wired in S8._
- **S7-routes-admin** — `routes/admin/contacts.ts` (delegate create/update to resolver; `contactSchema.externalId`/`anonymousId` nullable), `routes/admin/journeys.ts` (enroll → `eventProperties`, keep `properties` request field), `routes/admin/bulk.ts` (replay + batch-enroll → `eventProperties`, relax import externalId-required), `routes/admin/api-keys.ts` (scopes enum + `ingest`; OPTIONAL `requireScope("full-admin")` gate on create/revoke — flagged), `workflows/import-contacts.ts` (delegate to resolver, accept email-only rows). _dependsOn: S3-identity, S4-ingest._
- **S11-studio** — `studio/src/lib/admin-api.ts` repoint Debug `ingestEvent()` from `/v1/ingest` to `POST /v1/events` with the new body (eventProperties-only). _dependsOn: §2.5 (events route shape). Must land WITH/BEFORE the ingest.ts deletion (S6)._

### parallelGroup 5
- **S8-wire** — `routes/index.ts` (remove ingest mount; mount guarded `dataPlane` sub-app with `requireApiKey`+`requireScope("ingest")`; `/v1/emails/*` rate-limit; mount `/v1/lists`), `container.ts` (`lists?`/`enabledLists?` options + `buildListRegistry` + `listRegistry` on client), `index.ts` (export lists public surface). _dependsOn: S5-lists-core, S6-routes-dataplane, S2-auth._

### parallelGroup 6
- **S12-consumer** — `apps/api`: `webhook-sources/posthog.ts` split (person→contactProperties, event→eventProperties+`_posthogEventId`), new `lists/index.ts`, thread `lists` into `index.ts` + `worker.ts` `createHogsendClient`. _dependsOn: S8-wire (container `lists?` option), S4-ingest (IngestEvent shape), S5-lists-core (defineList export)._
- **S13-scaffold** — `create-hogsend` template: mirror posthog split, `lists/index.ts`, `lib/hogsend.ts`, `bootstrap.ts` mint ingest key (step 7), `_package.json` add `@hogsend/client`+`@hogsend/cli` pins, `env.example`, `README.md`, `src/template-manifest.ts` add `client`+`cli`, thread `lists` into template `index.ts`/`worker.ts`. _dependsOn: S8-wire (container option), S9-client (package exists), S10-cli (write commands)._

### parallelGroup 7 (last)
- **S14-tests** — rewrite `webhook-sources.test.ts` (two-bag assertions), `buckets.test.ts` (`check()` helper → `{eventProperties, contactProperties}`, migrate "merged contact state" suite to contact-state-only), `admin-journeys.test.ts` (verify enroll still green), `smoke.ts` (new event body); NEW dataplane/auth/identity-merge suites. Full `cd apps/api && pnpm test` + `pnpm check-types` (the IngestEvent type change is the exhaustiveness net — any un-migrated construction site must compile-error). _dependsOn: all engine + consumer stages._

---

## 5. Destructive cleanup (consolidated, deduped)

| Path | Action | Reason |
|---|---|---|
| `packages/engine/src/routes/ingest.ts` | delete | Unauthenticated `/v1/ingest` (required userId, single `properties` bag) — superseded outright by authed `POST /v1/events` (D2 split, email\|userId). No compat shim (DESTRUCTIVE LATITUDE + D5). Only live caller is Studio Debug (repointed in S11) before deletion. Zero tests reference `/v1/ingest`. |
| `packages/engine/src/lib/contacts.ts` (upsertContact body) | modify | The `onConflictDoUpdate({ target: contacts.externalId })` upsert cannot create/update email-only or anonymous contacts and has no merge/alias semantics. Body replaced by a delegation to `resolveOrCreateContact`; the `upsertContact` symbol is retained as a thin wrapper so `ingestion.ts`/`import-contacts.ts` keep compiling. |
| `packages/engine/src/lib/ingestion.ts` (`IngestEvent.properties`, the merge-every-event-prop line) | modify | `properties` field deleted; the `upsertContact({ properties: event.properties })` conflation (lines 84-94) folded into the awaited `resolveOrCreateContact` passing ONLY `contactProperties`. `user_events`/Hatchet/checkExits read `eventProperties`. |
| `packages/engine/src/buckets/check-membership.ts` (event-payload overlay) | modify | The `{ ...contactProperties, ...(properties ?? {}) }` overlay leaked raw event payload into property eval (the D2 conflation on the bucket side). Removed — property predicates eval against contact state ⊕ this-ingest contactProperties patch only. |
| `packages/engine/src/routes/admin/contacts.ts` (hand-rolled create/update + 409) | modify | Duplicate-externalId existence check + raw insert + duplicated `COALESCE||patch` merge SQL replaced by `resolveOrCreateContact`. 409-on-existing dropped (resolver is upsert/merge-first). Request schema `externalId` relaxed to email-or-externalId; response `externalId` → nullable. |
| `packages/engine/src/middleware/api-key.ts` (`requireScope` Math.max-only logic) | modify | Latent bug: `SCOPE_HIERARCHY["ingest"] ?? 0` → ANY key passes `requireScope("ingest")`. Replaced by `hasScope` (orthogonal ingest + full-admin implication). Not a deletion but a required semantic replacement. |
| `packages/engine/src/routes/email/unsubscribe.ts` (private `upsertPreference`) | modify | The jsonb_set category-flip is duplicated logic; extracted to `lib/preferences.ts` `upsertEmailPreference` (single source of truth) and imported back. No behavior change to the route. |
| `apps/api/src/webhook-sources/posthog.ts` (merged `properties` bag) | modify | The canonical conflation example: spreads `event.properties` + `person.properties` into one bag. Split: person→`contactProperties`, event(+`_posthogEventId`)→`eventProperties`. Scaffold copy kept in lock-step (S13). |

---

## 6. Open risks (implementers MUST watch)

1. **JOIN KEY IS A STRING, NOT THE UUID.** All 5 contact-referencing tables (`user_events`, `journey_states`, `email_sends`, `bucket_memberships`, `email_preferences`) join on the text `user_id` (= `external_id` today), NOT `contacts.id`. Merge must REWRITE that string on all 5. Anon contacts carry `anonymous_id` as their `user_id`. Getting the survivor target string wrong silently orphans history. This is the single most important merge invariant.
2. **`user_events.userId` / `journey_states.userId`+`userEmail` are NOT NULL.** Email-only/anon events (D1 optional userId) require `ingestEvent` to resolve a canonical key FIRST (the awaited `resolveOrCreateContact` → `external_id ?? anonymous_id ?? contact.id`). Do NOT relax the required-userId path without that resolution step or NOT NULL inserts throw.
3. **Unique-index violations during merge rewrite.** `uq_user_journey_active` and `uq_user_bucket_active` throw if survivor+loser both active in the same journey/bucket; `email_preferences uq(user_id,email)` likewise. Pre-resolve the loser's duplicate (exit journey state / soft-leave membership / FOLD prefs) BEFORE the bulk rewrite.
4. **Ordering vs partial-unique-on-not-deleted.** Soft-delete the loser FIRST (frees its external_id/email/anonymous_id values), THEN copy keys onto the survivor — all in one tx. Reverse order self-collides.
5. **Alias-fallback lookup is mandatory.** After a merge the loser's old keys sit on a soft-deleted row; `findByExternalId`/`findByEmail` (filter `deleted_at IS NULL`) miss them. Each `findByX` MUST fall back to `contact_aliases`, else the next event under a stale key mints a fresh contact and re-splits history.
6. **Suppression/unsubscribe must never be lost on merge.** `checkSuppression` reads prefs by EMAIL; enrollment guards read by `user_id`. The two axes can diverge across loser/survivor. The pref FOLD rule (OR the unsub/suppress flags, FALSE wins on category conflict) is a compliance requirement.
7. **Read-after-write race in bucket eval.** `checkBucketMembership` reads the EXISTING contact row while the merge happens in the same `ingestEvent`. The this-ingest `contactProperties` overlay covers a contact's very first event. Without the overlay, the first event after a property change mis-evaluates.
8. **Observable behavior change (D2).** Journeys/buckets that relied on the old conflation break: `trigger.where` now sees ONLY `eventProperties`; bucket prop-criteria see ONLY contact state. Accepted — call out in release notes. The `buckets.test.ts` "merged contact state" suite encodes the OLD overlay and must be migrated, not patched.
9. **Hatchet push key stays `properties`.** The IngestEvent field rename is `properties → eventProperties`, but the Hatchet `events.push(..., { properties })` wire key MUST stay `properties` — bucket tests assert on the pushed payload. Renaming it causes false test breakage.
10. **email_preferences keying for email-only contacts.** PK is `(user_id NOT NULL, email NOT NULL)`. Phase-1 rule: list/preference writes REQUIRE an email; `user_id` uses `external_id ?? contact.id`. This fallback MUST be consistent across subscribe writes, preference-center reads, AND unsubscribe-token issuance or rows won't line up.
11. **Reserved category collision (D3).** `transactional`/`journey` already live in `email_preferences.categories`. `defineList` must reject those ids. List ids share the category namespace.
12. **ListRegistry singleton default safety.** `tracked.ts` runs in API AND worker; a send before `createHogsendClient` installs the registry (or a test without a client) must get an EMPTY registry that yields legacy behavior (unknown id → `defaultOptIn true` → block only on explicit false). Empty-default, NOT throw-on-unset.
13. **`requireScope` rewrite touches every admin endpoint.** `hasScope` is exercised by all admin routes. Add the `hasScope` unit table + a read-only-key-403s-on-`/v1/events` regression test. No existing api-key middleware unit test exists.
14. **KEY_CACHE 60s staleness.** Revoking/editing a data key may be honored for up to 60s (matches existing admin behavior). Document; revocation isn't instant.
15. **Rate-limit prefix is load-bearing.** `/v1/emails` MUST use a distinct prefix (`ratelimit:emails`) so email sends don't share the sliding-window budget with contact upserts. Middleware order on `/v1/emails`: `requireApiKey → requireScope → rateLimit` (auth before limit, never a shared "anonymous" bucket). Test env short-circuits rate-limit (`NODE_ENV==="test"`) — assert via `createRateLimit` in isolation.
16. **Drizzle functional partial-unique on `lower(email)`.** Confirm `db:generate` emits `CREATE UNIQUE INDEX ... ON contacts (lower(email)) WHERE ...`. If not expressible, fall back to a normalized `email_normalized` generated column + plain partial-unique index. Existing seeded rows (all have external_id) must survive the migration with no collisions.
17. **admin `contactSchema.externalId` non-nullable.** Response schema returns `row.externalId` directly; once nullable, email-only contacts 500 unless the schema + serializer become `.nullable()`. Easy to miss (it's a response schema).
18. **Studio Debug repoint ordering.** `admin-api.ts:559` is the ONLY live consumer of the old `/v1/ingest` shape. Repoint to `/v1/events` (S11) BEFORE deleting `ingest.ts` (S6) or the Debug panel silently 404s.
19. **`@hogsend/client` runtime model + publish order.** Unlike the engine (raw .ts), the client MUST ship compiled ESM+CJS+dts (consumed by arbitrary app code). First npm publish is MANUAL (CI can't create a new `@hogsend/*` package) BEFORE `create-hogsend` pins `@hogsend/client@^{{ENGINE_VERSION}}`, else a fresh scaffold install fails to resolve. Keep it + `@hogsend/cli` on the engine version-line each release (template-manifest updated).
20. **Bootstrap key mint idempotency.** `bootstrap.ts` INSERT into `api_keys` runs AFTER migrations, must skip when a real `hsk_` key is already in `.env` (no duplicate keys on re-run), and warn-not-die if `DATABASE_URL` is unreachable.
21. **GDPR / email_hash deferred.** Storing only normalized raw email means suppression-after-erasure (delete email, keep a hash to stay suppressed) is not yet possible. Flagged for a follow-up if persistent-suppression-after-erasure is required.
22. **`relations.ts` logical joins still reference `contacts.externalId`.** Anonymous-only contacts (external_id NULL) won't resolve through Drizzle relational queries until identified. Acceptable (anon contacts have no prefs/journeys yet) but document so readers don't assume `contacts.id` is the relational key.

---

## 7. Acceptance gate

`cd apps/api && pnpm test` green (all migrated + new suites) AND `pnpm check-types` clean across workspaces AND `pnpm --filter @hogsend/client build` emits ESM+CJS+dts. The `check-types` pass is the exhaustiveness net: the `IngestEvent` field rename must compile-error on any un-migrated construction site.
