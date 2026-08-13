# PRD 09 — Data plane: `/v1/accounts/*`

## Goal

Expose the link store (PRD 03) as the AUTHORITATIVE pull plane described in
`DECISIONS.md` §3.2: list, reverse lookup, unlink, insert-only import, secret-key mint and the two
userToken-gated browser routes. This is the surface a customer reconciles against and the surface
that removes their need for a backend endpoint before they can drop in a link button.

## Locked decisions specific to this PRD

- Route namespace is `/v1/accounts/*` (DECISIONS §2). The primitive is `defineAccountLink`, the mint
  helper is `mintAccountLinkUrl`; nothing here may be named `mintLink`, which already exists
  (`packages/engine/src/lib/links.ts`).
- The pull plane is strongly consistent and Hogsend wins any disagreement (DECISIONS §3.2 PULL row).
  Every read returns the live row, never a cached mirror.
- **Only a completed hosted callback may MOVE a link** (DECISIONS §6.1). No route in this PRD may
  displace a live owner.
- **`POST /v1/accounts/import` is the ONE carve-out and it is INSERT-ONLY** (DECISIONS §6.2): it
  returns `{ inserted, conflicts }` and stamps `method: "import"`.
- **Browsers can never mint for an arbitrary contact** (DECISIONS §6.5). `POST /v1/accounts/link-url`
  requires a server-minted `userToken` and mints for that user only.
- **`GET /v1/accounts/me` returns display fields only and never confirms existence** (DECISIONS §6.9):
  a missing/invalid token yields an EMPTY LIST, not an error.
- Every mutation carries a `version` per DECISIONS §5. The data plane READS `version` and returns it
  on secret-key responses; it never computes one itself (that is PRD 03's advisory-locked
  transaction).
- **`version` is a `bigint` and is serialized as a decimal STRING** (DECISIONS §5.1). Every route
  schema types it `z.string()`, every serializer writes `String(row.version)`, and nothing on this
  plane calls `parseInt`/`Number()` on it. A Postgres bigint exceeds `Number.MAX_SAFE_INTEGER`, and
  the customer's whole contract is an exact `incoming.version > stored.version` comparison, so a
  rounded version breaks the guard invisibly. Same representation as PRD 08's payloads and PRD 12's
  SDK types.
- **There are TWO revoke surfaces and the in-app one is primary** (DECISIONS §14). A player signed in
  on the publisher's own site uses `GET /v1/accounts/me` plus the userToken-gated revoke (T8b), keyed
  on `externalId`, with no email anywhere. PRD 11's hosted manage page is the fallback for a player
  with no session. The secret-key `DELETE` (T4) is the operator/reconciliation path and is neither of
  those.
- Unlink from this plane stamps `reason: "api"` and emits `account.unlinked` (DECISIONS §8) from the
  intent layer, exactly as `routes/groups/index.ts:276` and `:331` emit `group.*`. **The store never
  emits** (DECISIONS §15.7): these routes own their emit sites, and `lib/account-links.ts` contains
  no `emitOutbound` call at all. Both directions matter, because a store emit plus a route emit for
  the same mutation is silently absorbed by the `(endpointId, dedupeKey)` index, so
  "emits exactly one account.unlinked" would pass for the wrong reason.
- **`afterLink` / `afterUnlink` are invoked by PRD 03's store and by no route here** (DECISIONS
  §15.4). Every mutation call passes `hooks: container.accountLinkHooks` and calls nothing itself.
- **`/v1/accounts/*` route guards must BRANCH, never stack** (DECISIONS §15.1). Hono runs every
  matching `use` and `app.route("/v1", v1)` flattens middleware, so a blanket guard on
  `/accounts/:provider/:providerUserId` also fires on `/accounts/me/revoke` and on PRD 07's
  `/accounts/:provider/start` and `/accounts/:provider/callback`. See T9; it is the most dangerous
  detail in this PRD.

## Grounding in the real tree (read before writing code)

- `packages/engine/src/routes/groups/index.ts` — the template. Zod schemas + `serializeGroup`
  (`:19-43`), `createRoute()` + `OpenAPIHono().openapi()` chain (`:256-417`), intent-layer
  `emitOutbound` calls (`:276`, `:331`, `:380`), the "this router does NOT re-apply auth" comment
  (`:250-255`).
- `packages/engine/src/routes/index.ts` — router registration and guards. The secret-only prefix loop
  is `:134-137`; the literal `/contacts/find` guard is `:138`; the `/flags` (browser) vs
  `/flags/evaluate` (secret) split is `:82-88` + `:143`; the long comment at `:112-127` is the exact
  hazard this PRD inherits.
- `packages/engine/src/middleware/api-key.ts` — `hasScope` (`:35`) treats an unknown required scope as
  ORTHOGONAL (explicit grant or `full-admin`), so a new `accounts` scope needs no hierarchy edit.
  `requireApiKey` is `:65`, `requireScope` is `:146`.
- `packages/db/src/schema/api-keys.ts:19` — `scopes: jsonb(...).$type<string[]>().notNull().default(["read"])`.
  Scopes are free-form strings in a jsonb array; adding `accounts` is a docs + validation change, not
  a migration.
- `packages/engine/src/lib/user-token.ts:64` — `verifyUserToken({ token, secret })` throws
  `InvalidUserTokenError`. Signed (not encrypted) HMAC over `{ userId, exp }` on `BETTER_AUTH_SECRET`.
- `packages/engine/src/routes/_shared.ts:42` — `gatePublishableIdentity`, the existing pattern for
  "a pk_ key may only act on a userToken-proven userId".
- `packages/engine/src/routes/feed/recipient.ts:73` — `resolveFeedRecipient`, the precedent for a
  server-trusted recipient key derived ONLY from a verified token, never from the request.
- `packages/engine/src/lib/outbound.ts:519` — `emitOutbound({ db, hatchet, logger, event, payload, dedupeKey })`.

## Acceptance criteria (EARS)

### Auth and scope

- WHEN a request reaches `GET /v1/accounts`, `GET|DELETE /v1/accounts/:provider/:providerUserId`,
  `POST /v1/accounts/import` or `POST /v1/accounts/mint-link` without a secret API key, the system
  SHALL respond `401` and SHALL NOT read or mutate `linked_accounts`.
- WHEN a request presents a secret API key whose `scopes` contain neither `accounts` nor
  `full-admin`, the system SHALL respond `403 {"error":"Forbidden: insufficient scope"}`.
- WHEN a request presents a publishable (`pk_`) key to any secret-only accounts route, the system
  SHALL respond `403` and SHALL NOT leak whether the addressed link exists.
- WHEN an API key holds `full-admin`, the system SHALL treat it as holding `accounts` (the orthogonal
  arm of `hasScope`, `middleware/api-key.ts:35-40`) with no change to `SCOPE_HIERARCHY`.

### Route ordering and guard shadowing (the hazard)

- WHEN the accounts routers are registered, the system SHALL register every LITERAL path
  (`/v1/accounts/me`, `/v1/accounts/manage`, `/v1/accounts/import`, `/v1/accounts/mint-link`,
  `/v1/accounts/link-url`) BEFORE the parameterised `/v1/accounts/{provider}/{providerUserId}` route.
- WHEN auth middleware is registered for the accounts surface, the system SHALL NOT register a
  `v1.use("/accounts/*", requireApiKey, ...)` catch-all, because a `/<prefix>/*` `use` in Hono also
  matches the bare `/<prefix>` path and every sibling literal, which would `401` the
  browser-reachable `/v1/accounts/me` and `/v1/accounts/link-url` and the UNAUTHENTICATED
  `/v1/accounts/manage` (PRD 11). Each guarded path SHALL be enumerated explicitly, mirroring
  `routes/index.ts:138`.
- WHEN `GET /v1/accounts/me` is called with a valid `userToken` and a publishable key, the system
  SHALL reach the handler (not a `401` from a secret-only guard).
- WHEN `GET /v1/accounts/manage?token=` is called with no API key at all, the system SHALL reach the
  PRD 11 handler and SHALL NOT respond `401`.

### `GET /v1/accounts` (list)

- WHEN called with `contactId`, the system SHALL return every LIVE link for that contact.
- WHEN called with `email`, the system SHALL resolve the contact first and return that contact's live
  links.
- WHEN called with `provider` alone, the system SHALL return live links for that provider, newest
  first, paginated by `limit` (default 50, max 200) and `offset`.
- WHEN called with none of `contactId` / `email` / `provider`, the system SHALL respond `400`.
- WHEN a link has `tokensRevokedAt` set, the system SHALL return that field (DECISIONS §10) and SHALL
  NOT return the sealed `tokens` blob under any circumstance.

### `GET /v1/accounts/:provider/:providerUserId` (reverse lookup)

- WHEN a live link exists for `(provider, providerUserId)`, the system SHALL return the full
  operator-facing row including `contactId`, `version`, `linkedAt`, `method` and `tokensRevokedAt`.
- WHEN no live link exists, the system SHALL respond `404` with the `errorSchema` shape used at
  `routes/groups/index.ts:300`.
- WHEN `providerUserId` contains reserved URL characters, the system SHALL match the same value the
  store wrote (path segments are decoded once by Hono; the SDK encodes once).

### `DELETE /v1/accounts/:provider/:providerUserId` (unlink)

- WHEN a live link exists, the system SHALL unlink it through PRD 03's `unlinkAccount` with
  `reason: "api"`, SHALL allocate a new `version` inside that call's advisory-locked transaction, and
  SHALL return `{ unlinked: true, version }` with `version` as a decimal STRING.
- WHEN no live link exists, the system SHALL return `{ unlinked: false }` with status `200` and SHALL
  emit nothing.
- WHEN an unlink succeeds, the system SHALL emit exactly one `account.unlinked` with the FULL CURRENT
  STATE payload of DECISIONS §8 and `dedupeKey = "al:<provider>:<uid>:v<version>"` (DECISIONS §5.5).
- WHEN an unlink succeeds, `afterUnlink` SHALL have been invoked EXACTLY ONCE, by PRD 03's store
  (DECISIONS §15.4). This route passes `hooks: container.accountLinkHooks` into `unlinkAccount` and
  invokes nothing itself. `grep -n "afterUnlink" packages/engine/src/routes/accounts/` returns
  nothing.

### `POST /v1/accounts/import` (INSERT-ONLY)

- WHEN an import row addresses a `(provider, providerUserId)` that has NO live owner, the system
  SHALL insert a link for the supplied contact with `method: "import"` and count it in `inserted`.
- WHEN an import row addresses a `(provider, providerUserId)` that HAS a live owner, the system SHALL
  leave the existing row completely untouched (same `contactId`, same `version`, same `linkedAt`) and
  SHALL report the row under `conflicts` with the existing owner's `contactId`.
- WHEN an import row addresses a pair that has a live owner and that owner IS the supplied contact,
  the system SHALL treat it as a conflict-free no-op and SHALL NOT allocate a new version.
- WHEN an import row would violate a `multiple: false` provider's one-per-contact policy, the system
  SHALL report it under `conflicts` and SHALL NOT apply `onConflict: "replace"` — replacement is a
  MOVE and only a hosted callback may move a link (DECISIONS §6.1).
- WHEN an import batch contains any conflict, the system SHALL still apply every non-conflicting row
  (partial success) and SHALL respond `200` with both counts.
- WHEN an import inserts a link, the system SHALL emit `account.linked` with `method: "import"` and
  `relink: false`.
- WHEN an import row references a contact that does not exist, the system SHALL report it under
  `conflicts` with a `reason` and SHALL NOT mint a contact.
- WHEN the batch exceeds 1000 rows, the system SHALL respond `400`.

### `POST /v1/accounts/mint-link` (secret)

- WHEN a secret `accounts`-scoped key posts `{ provider, contactId }` (or `{ provider, email }`), the
  system SHALL mint an `account_link`-purpose state token (PRD 07) sealing THAT contact and SHALL
  return `{ url, expiresAt }`, where `url` is the ENGINE-origin
  `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<state>` (DECISIONS §15.2) and NEVER the provider's
  authorize URL.
- WHEN the provider id is not in `client.accountLinkProviders`, the system SHALL respond `404`.
- WHEN the Redis mint throttle rejects or Redis is unavailable, the system SHALL respond `429` and
  SHALL NOT return a URL (fail-closed, DECISIONS §6.8, mirroring
  `cold-connect/throttle.ts:47-75`).

### `POST /v1/accounts/link-url` (userToken-gated)

- WHEN the body carries a `userToken` whose HMAC verifies against `BETTER_AUTH_SECRET` and is
  unexpired, the system SHALL mint a state token sealing the contact resolved from the token's
  `userId` ONLY, and SHALL return `{ url, expiresAt }` with the SAME engine-origin `/start?t=` shape
  as `mint-link`.
- WHEN `url` is returned, its origin SHALL equal `new URL(API_PUBLIC_URL).origin` (DECISIONS §15.2).
  PRD 13 derives its `postMessage` `expectedOrigin` from this value, so a provider-origin URL here
  makes every embed link time out with `AccountLinkTimeoutError` despite the link having committed
  server-side, and PRD 13's fake-`Window` tests cannot detect it. Assert the origin, not just that a
  string came back.
- WHEN the body carries a `contactId`, an `email`, or a `userId` that differs from the token's
  `userId`, the system SHALL respond `403` and SHALL NOT mint. The contact sealed into the state
  token comes from the token, never from the request (DECISIONS §6.3, §6.5).
- WHEN the `userToken` is absent, malformed, expired or badly signed, the system SHALL respond `403`
  and SHALL NOT mint.
- WHEN the mint throttle rejects, the system SHALL respond `429` and SHALL NOT return a URL.

### `GET /v1/accounts/me` (userToken-gated, non-confirming)

- WHEN a valid `userToken` is presented, the system SHALL return `{ accounts: [...] }` containing ONLY
  `provider`, `username`, `avatarUrl` and `linkedAt` for that user's live links.
- WHEN the response is serialized, the system SHALL NOT include `providerUserId`, `contactId`,
  `version`, `method`, `tokens`, `tokensRevokedAt`, `email` or any internal id, under any query
  parameter.
- WHEN the `userToken` is absent, malformed, expired, badly signed, or names a `userId` with no
  contact, the system SHALL respond `200 { "accounts": [] }` — the SAME status, the SAME body shape
  and an indistinguishable response from "this user exists and has no links". It SHALL NOT respond
  `401`, `403` or `404`, and SHALL NOT vary its error body.
- WHEN two requests are made, one with a valid token for a link-less user and one with a forged
  token, the system SHALL produce byte-identical response bodies.

### `POST /v1/accounts/me/revoke` (userToken-gated, the primary player unlink)

- WHEN a valid `userToken` is presented with a `provider`, the system SHALL unlink every live link
  that token's contact holds for that provider with `reason: "player"`, each at its own new version,
  and SHALL return `{ revoked: <count> }`.
- WHEN the request body carries `contactId`, `email` or any other identity claim, the system SHALL
  respond `403` and SHALL NOT mutate. Ownership comes from the token, never from the body.
- WHEN the `userToken` is absent, forged, expired, or names a user with no contact, the system SHALL
  respond `200 { "revoked": 0 }` and SHALL mutate nothing, with a body indistinguishable from a valid
  token that had nothing to revoke (DECISIONS §6.9).
- WHEN a revoke succeeds, the system SHALL emit exactly one `account.unlinked` per unlinked row, with
  the full current state payload and `dedupeKey = "al:<provider>:<uid>:v<version>"`. `afterUnlink`
  fires once per row, from PRD 03's store, not from here.
- WHEN a revoke calls `unlinkAccount`, it SHALL pass `expectContactId: <the token's resolved contact
  id>` on EVERY per-row call, so ownership is checked INSIDE the pair's advisory-locked transaction
  rather than in application code beforehand. WHEN the store returns
  `{ status: "rejected", reason: "not_owner" }`, the route SHALL count it as not-revoked and return
  its ordinary non-confirming `200 { revoked: n }`, never a 403 or 404.
- WHEN a hosted callback relinks the pair to another contact between the route's read and the write,
  the system SHALL NOT unlink the new owner's link. Without `expectContactId` this is a live
  read-then-write race, the same one this PRD already forbids for the import path.
- WHEN the routes are registered, the LITERAL `/v1/accounts/me/revoke` SHALL be matched before
  `/v1/accounts/{provider}/{providerUserId}`.

### Version serialization

- WHEN any response carries a `version`, the system SHALL serialize it as a decimal string.
- WHEN a link's version exceeds `Number.MAX_SAFE_INTEGER`, the system SHALL return it intact, with a
  test asserting the exact string round-trips through the HTTP response (DECISIONS §5.1).

## Tasks

### T1 — The `accounts` scope
_Boundary:_ `packages/engine`
_Depends:_ —

Add `accounts` to the engine's documented scope vocabulary. No `SCOPE_HIERARCHY` edit:
`hasScope` (`packages/engine/src/middleware/api-key.ts:35-40`) already treats an unrecognised
required scope as orthogonal, so `requireScope("accounts")` passes on an explicit grant or on
`full-admin` and fails otherwise. Extend whatever admin API-key create/update Zod enum lists valid
scopes (grep `"ingest"` under `packages/engine/src/routes/admin/`) to accept `accounts`.

Tests (`apps/api/src/__tests__/accounts-dataplane.test.ts`):
- `rejects a key without the accounts scope with 403`
- `accepts a full-admin key on the accounts plane`
- `accepts a key granted accounts explicitly`
- Mutation check: flipping `requireScope("accounts")` to `requireScope("ingest")` must make at least
  one of these fail (no vacuous green).

### T2 — Serialization boundary: two shapes, one row
_Boundary:_ `packages/engine`
_Depends:_ —

In `packages/engine/src/routes/accounts/serialize.ts`, define the two Zod schemas and the two
serializers, mirroring `serializeGroup` (`routes/groups/index.ts:31-43`):

```ts
export const linkedAccountSchema: z.ZodObject<{
  provider: z.ZodString;
  providerUserId: z.ZodString;
  contactId: z.ZodString;
  username: z.ZodNullable<z.ZodString>;
  avatarUrl: z.ZodNullable<z.ZodString>;
  method: z.ZodEnum<["oauth", "import"]>;
  /** bigint as a decimal STRING (DECISIONS §5.1), never a JSON number. */
  version: z.ZodString;
  linkedAt: z.ZodString;
  tokensRevokedAt: z.ZodNullable<z.ZodString>;
}>;

/** The ONLY shape `/v1/accounts/me` may return. Structurally cannot carry an id. */
export const publicLinkedAccountSchema: z.ZodObject<{
  provider: z.ZodString;
  username: z.ZodNullable<z.ZodString>;
  avatarUrl: z.ZodNullable<z.ZodString>;
  linkedAt: z.ZodString;
}>;

export function serializeLinkedAccount(row: LinkedAccount): z.infer<typeof linkedAccountSchema>;
export function serializePublicLinkedAccount(row: LinkedAccount): z.infer<typeof publicLinkedAccountSchema>;
```

`serializePublicLinkedAccount` builds a fresh object literal with four keys. It never spreads the
row: a spread is how `providerUserId` leaks the day someone adds a column.

Tests (`apps/api/src/__tests__/accounts-me-nonconfirmation.test.ts`):
- `serializePublicLinkedAccount emits exactly four keys` (assert `Object.keys(...)` deep-equals the
  literal set, so a future column addition fails the test rather than leaking).

### T3 — `GET /v1/accounts` + `GET /v1/accounts/:provider/:providerUserId`
_Boundary:_ `packages/engine`
_Depends:_ T2

`packages/engine/src/routes/accounts/index.ts`, one `OpenAPIHono<AppEnv>()` chain in the shape of
`routes/groups/index.ts:256`. Reads go through PRD 03's `listLinkedAccounts` /
`getLinkedAccountByProviderUser` in `packages/engine/src/lib/account-links.ts`; the router does no
SQL of its own. Router carries NO internal auth (the prefix guards in `routes/index.ts` own it),
with the same explanatory comment as `routes/groups/index.ts:250-255`.

Tests in `apps/api/src/__tests__/accounts-dataplane.test.ts`:
- `lists live links by contactId`
- `lists live links by email`
- `lists by provider with limit and offset`
- `400s when no filter is supplied`
- `reverse lookup returns the owning contactId and version`
- `reverse lookup 404s an unknown pair`
- `reverse lookup 404s an UNLINKED pair` (an unlinked row is history, not a live owner)
- `never returns the sealed tokens blob`

### T4 — `DELETE /v1/accounts/:provider/:providerUserId`
_Boundary:_ `packages/engine`
_Depends:_ T3

Calls `unlinkAccount({ provider, providerUserId, reason: "api" })` from PRD 03. On
`{ unlinked: true }` fire `emitOutbound` exactly as `routes/groups/index.ts:276` does — intent layer,
`void ... .catch(logger.warn)`, with `dedupeKey: "al:" + provider + ":" + providerUserId + ":v" + version`.

Tests (`apps/api/src/__tests__/accounts-dataplane.test.ts`):
- `unlinks a live link and returns the new version`
- `returns unlinked:false for an unknown pair and emits nothing`
- `emits exactly one account.unlinked with reason "api" and a versioned dedupeKey`
- `a repeated DELETE emits nothing the second time`

### T5 — `POST /v1/accounts/import`, insert-only
_Boundary:_ `packages/engine`
_Depends:_ T3

```ts
POST /v1/accounts/import
body: {
  rows: Array<{
    provider: string;
    providerUserId: string;
    contactId?: string;   // exactly one of contactId | email
    email?: string;
    username?: string;
    avatarUrl?: string;
    linkedAt?: string;    // ISO; preserves the customer's historical timestamp
  }>;                     // max 1000
}
200: {
  inserted: number;
  conflicts: Array<{
    provider: string;
    providerUserId: string;
    reason: "already_linked" | "singleton_conflict" | "unknown_contact";
    ownerContactId?: string;
  }>;
}
```

Implemented against a PRD 03 function `importLinkedAccounts` that performs a conditional INSERT under
the same advisory lock as every other mutation, with the live-owner check INSIDE the transaction.
The route must not read-then-write in application code: the "is there a live owner" test and the
insert are one statement (`INSERT ... WHERE NOT EXISTS (live owner)` or `ON CONFLICT DO NOTHING`
against the live partial-unique index from PRD 02), so a concurrent hosted callback cannot slip a
live owner in between the check and the write.

Tests (`apps/api/src/__tests__/accounts-import-insert-only.test.ts`) — this file is the security
proof for DECISIONS §6.2 and must be written first, failing:
- `imports a link where no live owner exists`
- `an import CANNOT steal a live link` — seed `(steam, 7656…)` owned by contact A at version N; import
  the same pair for contact B; assert `inserted === 0`, `conflicts[0].ownerContactId === A`, and then
  re-read the row and assert `contactId === A` AND `version === N` (unchanged) AND `linkedAt`
  unchanged. Also assert NO `account.linked` and NO `account.unlinked` was emitted.
- `an import CANNOT steal a live link even when the provider is multiple:false with onConflict:"replace"`
  — the replace policy is a hosted-callback-only behavior; assert `singleton_conflict`.
- `a partially conflicting batch still inserts the clean rows`
- `an import stamps method:"import" and relink:false on the emitted account.linked`
- `an unknown contact is reported as a conflict and mints no contact`
- Mutation check: deleting the live-owner guard from `importLinkedAccounts` must make
  `an import CANNOT steal a live link` fail.

### T6 — `POST /v1/accounts/mint-link` (secret)
_Boundary:_ `packages/engine`
_Depends:_ T3

Resolves the contact from `contactId` or `email` (secret keys are server-trusted, exactly as
`resolveFeedRecipient`'s secret arm at `routes/feed/recipient.ts:56-58`), throttles via the Redis
INCR helper, then calls PRD 07's `mintAccountLinkUrl`.

Tests (`apps/api/src/__tests__/accounts-mint-link.test.ts`):
- `mints for an arbitrary contact on a secret key`
- `404s an unregistered provider`
- `429s and returns no URL when the throttle rejects`
- `429s and returns no URL when Redis is unavailable` (fail-closed)

### T7 — `POST /v1/accounts/link-url` (userToken-gated)
_Boundary:_ `packages/engine`
_Depends:_ T6

The DX unlock (DECISIONS §11): the customer's browser calls this directly with a userToken their own
server minted, so they ship no backend endpoint. Guard with `requirePublishableOrIngest` (registered
BEFORE the secret literals in `routes/index.ts`, see T9) and then, INSIDE the handler, require a
verified `userToken` regardless of key tier — a secret key uses `mint-link` to act on someone else.

```ts
POST /v1/accounts/link-url
body: { provider: string; userToken: string; returnTo?: string }
200: { url: string; expiresAt: string }
403: { error: "Invalid userToken" } | { error: "userToken does not authorize this identity" }
```

`returnTo` is validated against the same configured origin allowlist PRD 10 uses for `postMessage`;
an off-allowlist value is a `400`, never a silent fallback (an open redirect on a link flow is a
phishing primitive).

Tests (`apps/api/src/__tests__/accounts-link-url.test.ts`):
- `mints for the token's userId`
- `the minted url origin equals API_PUBLIC_URL's origin and its path is /v1/accounts/<provider>/start`
  (DECISIONS §15.2; the same assertion PRD 13 depends on)
- `403s with no userToken`
- `403s on an expired userToken`
- `403s on a forged signature`
- `403s when the body claims a different userId than the token`
- `403s when the body carries contactId or email`
- `400s an off-allowlist returnTo`
- Mutation check: removing the "body claims a different identity" branch must fail the fifth test.

### T8 — `GET /v1/accounts/me`, non-confirming
_Boundary:_ `packages/engine`
_Depends:_ T2, T7

Reads `userToken` from the query string (a GET has no body; the feed routes read it the same way,
`routes/feed/recipient.ts:44-49`). Verification failure and "no such contact" take the SAME code
path: build an empty array and return. There is exactly one `return` shape in this handler.

Tests (`apps/api/src/__tests__/accounts-me-nonconfirmation.test.ts`):
- `returns display fields only for a valid token`
- `never returns providerUserId, contactId or version` (assert on the parsed JSON key set)
- `an absent token returns 200 with an empty list`
- `an expired token returns 200 with an empty list`
- `a forged token returns 200 with an empty list`
- `a token for a nonexistent user returns 200 with an empty list`
- `a forged token and a real link-less user return byte-identical bodies` — the non-confirmation
  property of DECISIONS §6.9, asserted on `await res.text()` equality and on status equality.
- Mutation check: changing the invalid-token branch to `403` must fail three of these.

### T8b — `POST /v1/accounts/me/revoke`, the userToken-gated unlink
_Boundary:_ `packages/engine`
_Depends:_ T2, T8

**This is the PRIMARY way a player unlinks** (DECISIONS §14). The publisher's site already knows the
signed-in player's user id and already mints a userToken for the rest of the SDK, so the in-app path
needs no email, no hosted page and no token in a URL. PRD 11's hosted manage page is the FALLBACK
for a player with no session. Without this route the only revoke surfaces are the secret-key
`DELETE` (a server call the player cannot make) and an emailed link (which a Steam-only player can
never receive), which would leave the normal case unserved.

```
POST /v1/accounts/me/revoke
body: { userToken: string, provider: string }
200:  { revoked: number }
```

- Verify the `userToken` exactly as T7 does (HMAC over `BETTER_AUTH_SECRET`, expiry, the
  `userId`-bearing payload) and resolve the contact from the token's `userId` (`externalId`), NEVER
  from the body. The body carries no `contactId`, no `email` and no `providerUserId`; a body that
  tries to name an identity is a `403`, the same rule as T7.
- Unlink EVERY live link the token's contact holds for `provider`, each through PRD 03's
  `unlinkAccount` with `reason: "player"` (not `"api"`, since a player asked) **and
  `expectContactId: <the token's contact id>`**, each allocating its own version inside its own
  advisory-locked transaction, each emitting one `account.unlinked` with the full-state payload and
  `dedupeKey = "al:<provider>:<uid>:v<version>"`, each calling `provider.revoke()` best-effort.
  `afterUnlink` fires inside the store; this route does not call it.

  `expectContactId` is not optional here and is not a duplicate of the enumeration that found the
  rows. The enumeration happens outside the lock; a hosted callback can relink the pair to a
  different contact in the window between reading and writing, and without the guard this route then
  unlinks the NEW owner's just-proven link. A `not_owner` result is simply not counted in `revoked`.
- Keyed on `provider`, not on `providerUserId`, deliberately: `GET /v1/accounts/me` returns four
  display keys and no id (T2), so the browser HAS no `providerUserId` to send and adding one to that
  response would undo the non-confirmation property of DECISIONS §6.9. For a `multiple: false`
  provider, the common shape for this ICP, that is exactly one row anyway. For a `multiple: true`
  provider it revokes the whole set for that provider, which is the only per-row-free semantics that
  does not leak an id; say so in the docs (PRD 16).
- **Non-confirming, like `/me`.** An absent, forged, expired or unknown-user token returns
  `200 { "revoked": 0 }`, the SAME status and body shape as a valid token with nothing to revoke.
  No `401`, no `403`, no `404` for a token problem. (The body-claims-an-identity `403` above is a
  different case: it is about the REQUEST being malformed, not about whether a contact exists.)
- Rate-limited on the same budget posture as the other browser-reachable literals.

Route ordering: `/v1/accounts/me/revoke` is a LITERAL two-segment path that would otherwise be
captured by `/v1/accounts/{provider}/{providerUserId}` with `provider = "me"`. Register it before the
parameterised route (T9), and note that `"me"` is already in `RESERVED_ACCOUNT_LINK_IDS` (PRD 01),
so no real provider can ever collide with it.

Tests (`apps/api/src/__tests__/accounts-me-revoke.test.ts`):
- `revokes the token contact's live link and emits account.unlinked with reason "player"`
- `a second call revokes nothing and emits nothing`
- `cannot revoke another contact's link` — mint a token for contact A, seed a live link for contact
  B on the same provider, assert B's link is still live with an unchanged `version` and that nothing
  was emitted
- `a forged token returns 200 { revoked: 0 } and mutates nothing`
- `a body carrying contactId or email is 403`
- `revokes every live link for a multiple:true provider and emits one event per row`
- `the emitted payload carries the full current state and a versioned dedupeKey`
- `a revoke racing a relink does not unlink the new owner's link` — the `expectContactId` test.
  Interleave a displacing `linkAccount` with the revoke on two connections, repeated enough times to
  hit both orderings, and assert the end state is never "the new owner's link was destroyed by the
  old owner's revoke". **Mutation guard:** dropping `expectContactId` from the call must make it
  fail.
- Mutation check: deriving the contact from the body instead of the token must fail the
  cross-contact test.

### T9 — Route registration and the guard-shadowing hazard
_Boundary:_ `packages/engine`
_Depends:_ T3, T5, T6, T7, T8, T8b

In `packages/engine/src/routes/index.ts`:

1. Register the browser-reachable literals FIRST, in the `requirePublishableOrIngest` block that
   already holds `/events`, `/lists`, `/feed`, `/flags` (`:69-88`):
   ```ts
   v1.use("/accounts/me", requirePublishableOrIngest);
   v1.use("/accounts/me/revoke", requirePublishableOrIngest);
   v1.use("/accounts/link-url", requirePublishableOrIngest);
   ```
   Both `/accounts/me` entries are enumerated, not written as `/accounts/me/*`: the wildcard trap
   below applies at every depth.
2. Register the secret-only literals EXPLICITLY, in the style of `/contacts/find` (`:138`) and
   `/flags/evaluate` (`:143`), never as a `/accounts/*` catch-all:
   ```ts
   v1.use("/accounts", requireApiKey, requireScope("accounts"));
   v1.use("/accounts/import", requireApiKey, requireScope("accounts"));
   v1.use("/accounts/mint-link", requireApiKey, requireScope("accounts"));
   ```
3. **The two-segment param pattern gets ONE branching guard, never a stacked pair** (DECISIONS
   §15.1). This is the single most dangerous line in the PRD:

   ```ts
   // Hono runs EVERY matching `use`, and `app.route("/v1", v1)` FLATTENS this
   // middleware into the same router — so a guard on this pattern also fires on
   // /accounts/me/revoke, /accounts/:provider/start and /accounts/:provider/callback.
   // Stacking requireApiKey + requireScope here 401s the entire hosted OAuth flow
   // (PRD 07's routes carry no Authorization header) and 403s the primary player
   // revoke (a pk_ key holds only ["ingest-public"], middleware/api-key.ts:35-40).
   // Branch, exactly like the method-branching /contacts guard at routes/index.ts:89-109.
   v1.use("/accounts/:provider/:providerUserId", async (c, next) => {
     const provider = c.req.param("provider");
     const second = c.req.param("providerUserId");
     // PRD 07's unauthenticated, self-verifying hosted flow. No guard at all.
     if (second === "start" || second === "callback") return next();
     // The browser-reachable player revoke. Publishable tier, userToken-gated inside.
     if (provider === "me") return requirePublishableOrIngest(c, next);
     // Everything else on this shape is the operator reverse lookup / unlink.
     return requireApiKey(c, () => requireScope("accounts")(c, next));
   });
   ```

   `"start"`, `"callback"` and `"me"` are all in `RESERVED_ACCOUNT_LINK_IDS` (PRD 01), so no real
   provider or `providerUserId` can reach these branches by accident. `"link"` is added to that list
   too if PRD 10's landing page ships (see below).

   As specified before this ruling, the stacked form made the entire hosted OAuth flow dead and PRD
   09's own test asserted only "is not 401" — which the broken route passes, because the failure
   arrives as a 403 from the scope check.
4. `/v1/accounts/manage` (PRD 11) gets NO guard here. It is the unauthenticated, token-bearing player
   page, the same posture as the `/v1/email` router at `:45`.
5. `v1.route("/accounts", accountsRouter)` alongside `v1.route("/groups", groupsRouter)` at `:158`.
   PRD 07's `/start` and `/callback` mount inside the SAME router. Do not mount them on `app` in the
   belief that this escapes the middleware: `app.route("/v1", v1)` flattens it, so it does not, and
   the v1 `GET /accounts/:provider/:providerUserId` handler would capture them anyway if it were
   registered first.

Inside `accountsRouter`, the `.openapi()` calls are ordered literals-first:
`/me` → `/me/revoke` → `/import` → `/mint-link` → `/link-url` → `/manage` → `/` (list) →
`/{provider}/start` → `/{provider}/callback` (PRD 07) → `/{provider}/{providerUserId}`.

The two PRD 07 routes are registered BEFORE the reverse lookup for the same literal-before-param
reason: `/{provider}/{providerUserId}` matches `/steam/callback` with `providerUserId = "callback"`,
so a later registration is captured by the earlier one and the callback 404s (or worse, is answered
by the reverse lookup as an unknown pair).

`/me/revoke` is the case where the two-segment safety margin below does NOT hold: it has exactly the
shape `/{provider}/{providerUserId}` matches, with `provider = "me"`. Its literal-first ordering is
load-bearing today, not a precaution for a future route, and `"me"` being in
`RESERVED_ACCOUNT_LINK_IDS` (PRD 01) is what stops a real provider from reaching it.

The precise hazard, stated so nobody re-derives it wrong:
- The **path-match** collision is narrower than it looks for the one-segment literals. `/v1/accounts/me`
  and `/v1/accounts/manage` are ONE segment; `/{provider}/{providerUserId}` is TWO, so Hono does not
  confuse them today, and it becomes real the moment anyone adds a single-segment param route
  (`GET /v1/accounts/{provider}`), which is an obvious future request. `/v1/accounts/me/revoke` is
  the exception: it is TWO segments and collides right now. Order literals first.
- The **middleware** collision is real TODAY and is the one that bites, at two different shapes. A
  `v1.use("/accounts/*", requireApiKey, ...)` in the style of the `:134-137` loop matches the bare
  `/accounts` path AND every literal sibling, including the browser-reachable `/accounts/me` and
  `/accounts/link-url` and the unauthenticated `/accounts/manage`. And a `use` on the two-segment
  PARAM pattern matches `/accounts/me/revoke`, `/accounts/steam/start` and
  `/accounts/steam/callback`, because Hono runs every matching `use` regardless of which handler
  eventually answers. That is exactly the `/contacts/*` and `/lists/*` trap documented at
  `routes/index.ts:112-127`, and it fails CLOSED and silently: the routes 401 or 403 and nobody
  notices until the embed ships. Enumerate the literals; BRANCH inside the one param guard.

Tests (`apps/api/src/__tests__/accounts-route-ordering.test.ts`). **Every one of these asserts
NEITHER 401 NOR 403**, not merely "not 401": the blanket guard fails with 403 from the scope check
on a `pk_` key, so a "not 401" assertion ships the broken route green. That is the exact weakness
this list is replacing.

- `GET /v1/accounts/me with a pk_ key and a valid userToken is neither 401 nor 403`
- `GET /v1/accounts/manage with no Authorization header is neither 401 nor 403`
- `POST /v1/accounts/link-url with a pk_ key is neither 401 nor 403`
- `POST /v1/accounts/me/revoke with a pk_ key and a valid userToken is neither 401 nor 403` — the
  primary player unlink (DECISIONS §14). Under the stacked guard this was a 403, forever.
- `GET /v1/accounts/steam/start with no Authorization header is neither 401 nor 403`
- `GET /v1/accounts/steam/callback with no Authorization header is neither 401 nor 403` — under the
  stacked guard the entire hosted OAuth flow was dead.
- `GET /v1/accounts with a pk_ key is 403` (secret-only stays secret-only)
- `GET /v1/accounts/steam/7656… with no key is 401` (the operator branch still guards)
- `a provider literally named "me" cannot shadow /v1/accounts/me` — register a fake provider id `me`
  and assert `GET /v1/accounts/me?userToken=…` still hits the me-handler while
  `GET /v1/accounts/me/123` hits the reverse lookup.
- `POST /v1/accounts/me/revoke reaches the revoke handler, not the reverse lookup` — the
  literal-before-param proof for the one route where the collision is live. It must FAIL when
  `/me/revoke` is registered after `/{provider}/{providerUserId}`.
- **Mutation check, run by hand and recorded in Implementation Notes:** replace the branching guard
  with the stacked pair
  `v1.use("/accounts/:provider/:providerUserId", requireApiKey, requireScope("accounts"))` and
  confirm the four "neither 401 nor 403" cases above FAIL. If they still pass, the assertions are
  vacuous and must be strengthened before this PRD is accepted.
- A second mutation check: replacing the explicit secret `use`s with a single `/accounts/*` wildcard
  must fail the first three tests.

### T10 — OpenAPI + changeset
_Boundary:_ `packages/engine`
_Depends:_ T9

Every route carries `tags: ["Accounts"]`, a `summary` and a `description` naming its auth tier, as the
groups routes do. Add a changeset for `@hogsend/engine` (minor): new `/v1/accounts/*` data plane and
the `accounts` API-key scope.

## Seams

None. Every route in this PRD is testable against the deterministic Fake provider from PRD 06; no
real Steam or Twitch credential is needed for the data plane.

## Done when

- [ ] All nine route behaviors have passing EARS-derived tests in the named test files.
- [ ] `accounts-import-insert-only.test.ts` proves an import cannot steal a live link, and the proof
      fails when the guard is removed.
- [ ] `accounts-me-nonconfirmation.test.ts` proves byte-identical bodies for a forged token and a
      link-less user.
- [ ] `accounts-route-ordering.test.ts` proves no guard shadows the browser, player OR hosted-flow
      routes, asserting **neither 401 nor 403** on each, with the stacked-guard mutation check run by
      hand and recorded in Implementation Notes.
- [ ] The two-segment param guard is ONE branching middleware, not a stacked
      `requireApiKey, requireScope` pair.
- [ ] Both player-facing revokes pass `expectContactId`, with the racing-relink test and its mutation
      guard.
- [ ] `grep -rn "afterLink\|afterUnlink" packages/engine/src/routes/accounts/` returns nothing: the
      store is the sole invoker (DECISIONS §15.4).
- [ ] `POST /v1/accounts/link-url` and `/mint-link` return an `API_PUBLIC_URL`-origin `/start?t=` URL,
      asserted on the origin.
- [ ] Any new test file in this PRD that seeds a webhook endpoint and asserts on `account.*` delivery
      rows (today: `accounts-dataplane.test.ts`, `accounts-me-revoke.test.ts`) is appended to
      `WEBHOOK_FANOUT` in `apps/api/vitest.config.ts` with a comment (PRD 08 T4b's rule).
- [ ] `GET /v1/accounts/me` cannot return `providerUserId`, `contactId` or `version` (asserted on the
      key set, not on a sample row).
- [ ] `accounts-me-revoke.test.ts` proves the userToken revoke works, is non-confirming, and cannot
      touch another contact's link. This is the PRIMARY player unlink surface (DECISIONS §14), so it
      is not optional polish.
- [ ] Every response schema types `version` as a string, and
      `grep -rn "parseInt\|Number(" packages/engine/src/routes/accounts/` returns nothing on a
      version path. A version above `Number.MAX_SAFE_INTEGER` round-trips through an HTTP response
      with a test.
- [ ] Changeset added for `@hogsend/engine`.
- [ ] From the worktree root (DECISIONS §4):
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Public-surface change, so also: `pnpm build`.

## Implementation Notes
