# PRD 11 — Player manage + revoke page

## Goal

Give the player a login-free page that lists the platform accounts they have linked and lets them
revoke any of them. Contact-bound HMAC token in the unsubscribe-token CRYPTO idiom but with its own
dedicated payload, GDPR-shaped (it can never reveal anything about a contact other than the token's
own), GET never mutates, rate-limited.

**This page is the FALLBACK surface, not the default.** DECISIONS §14 defines two revoke surfaces
and names the in-app one primary for this ICP: a player signed in on the publisher's own site hits
`GET /v1/accounts/me` plus the authenticated revoke, both gated by the server-minted **userToken**
and keyed on `externalId` (PRD 09). No email, no hosted page, no token in a URL. This hosted page
exists for the player with NO session who arrived from a link in an email or a DM. Build it as the
second door, and say so in the docs (PRD 16) so nobody wires the fallback as the main integration.

## Locked decisions specific to this PRD

- **The player manage token is a NEW, `contactId`-keyed token. It does NOT reuse the unsubscribe
  payload or its validator** (DECISIONS §3.3, §14). Reuse the HMAC CRYPTO SHAPE and the helpers from
  `@hogsend/email` (base64url payload, HMAC-SHA256 over `BETTER_AUTH_SECRET`, `timingSafeEqual`
  compare, `exp`); mint a dedicated payload keyed on `contactId`, and validate its action value
  STRICTLY. Two reasons, both load-bearing:
  1. **The unsubscribe payload REQUIRES an email** (`validateUnsubscribeToken` rejects a payload
     missing `externalId` OR `email`, `packages/email/src/unsubscribe-tokens.ts:104-111`;
     `generateUnsubscribeToken` writes both unconditionally, `:56-61`). **Steam never yields an
     email, ever** (DECISIONS §14), so an email-less player could never be issued a revoke link at
     all. Keying on `contactId` removes the requirement instead of working around it: Hogsend's
     contact model is already ID-first (`external_id ?? anonymous_id ?? id`, with `contact_aliases`
     as the source of truth since identity wave 2).
  2. **`validateUnsubscribeToken` checks that `payload.action` is PRESENT but never checks its
     VALUE** (`unsubscribe-tokens.ts:104-111`), and the preference-center route does not check it
     either (`routes/email/preferences.ts:51-67`). Since `generatePreferenceCenterUrl` mints an
     `action: "manage"` token into EVERY email footer with a 30-day TTL
     (`packages/email/src/unsubscribe-url.ts:28-45`), a manage page that accepted `"manage"` would
     turn every historical email into a live account-revocation credential. A dedicated token with
     strict action validation is immune to that by construction.
  **Fixing the shared validator is a SEPARATE ticket, deliberately out of this stack.** Do not
  broaden `validateUnsubscribeToken`, do not add tasks for it, and do not make this PRD depend on
  it.
- Revoke unlinks with `reason: "player"` and emits `account.unlinked` with the full versioned state
  payload (DECISIONS §8), through PRD 03's advisory-locked `unlinkAccount`.
- `provider.revoke()` is best-effort on unlink (DECISIONS §10). A provider-side revocation failure
  never blocks the local unlink.
- `afterUnlink` runs post-commit, at-least-once, fail-open, bounded 5s (DECISIONS §9), **invoked by
  PRD 03's store and by nothing else** (DECISIONS §15.4). This route passes the container's hooks in
  and calls none of them.
- `GET /v1/accounts/manage` is UNAUTHENTICATED by API key and carries NO accounts-scope guard. PRD 09
  T9 explicitly excludes it from every `/v1/accounts` guard; a `/accounts/*` wildcard would 401 the
  player.
- **The page is rendered with PRD 10's shared `hostedPageShell`, NOT with
  `packages/engine/src/lib/html.ts`.** That older helper interpolates its `body` argument raw
  (`html.ts:1-26`), and `routes/email/preferences.ts:207` interpolates a contact's `${email}` into it
  with no escaping. The instruction to mirror "the preference-center page shape" is honored at the
  level of layout and token flow only. This page renders provider-supplied `username` values, which
  are attacker influenced, so it takes the cold-connect posture (`textContent` writes,
  `jsonForScript` escaping). A deliberate divergence, not an oversight. The pre-existing
  `preferences.ts` interpolation is out of scope here and is NOT fixed by this PRD; it is worth its
  own ticket.

## Grounding in the real tree

- `packages/email/src/unsubscribe-tokens.ts` — the CRYPTO to reuse: `toBase64Url` (`:33`),
  `fromBase64Url` (`:37`) and `sign` (`:41`) are module-PRIVATE, plus the `timingSafeEqual` compare
  at `:90-95`, the expiry check at `:113-116`, and `InvalidTokenError` at `:24`. The payload types
  (`UnsubscribeTokenPayload` `:5`, `TokenOptions` `:13`) and `validateUnsubscribeToken` (`:73`) are
  the parts NOT reused: they require an email and never check the action value.
- `packages/email/src/unsubscribe-url.ts:28-45` — `generatePreferenceCenterUrl` mints
  `action: "manage"` into EVERY email footer, 30-day default TTL, no revocation.
- `packages/engine/src/routes/email/preferences.ts` — the page shape being mirrored: token validate
  (`:51-67`), the contact resolve wrapped so a probe never 500s (`:76-81`), per-row action links
  (`:101-113`), render (`:203-220`).
- `packages/engine/src/routes/email/unsubscribe.ts:56-60` — the `category` charset guard
  (`/^[a-z0-9_-]+$/i`), the precedent for validating a token field before it reaches a query.
- `packages/engine/src/routes/index.ts:45` — `v1.route("/email", emailRouter)` sits in the OPEN block
  with health/tracking/admin. Same posture the manage route needs.
- `packages/engine/src/middleware/rate-limit.ts` — `createRateLimit({ prefix, max, keyFn, disableInTest })`,
  `clientIpKey` for unauthenticated surfaces (`:43`), and the `disableInTest` note at `:22-28` (set it
  `false` to assert a 429 in the suite).
- `packages/engine/src/cold-connect/index.ts:146-158` — the "GET never binds" law, stated on the route.

## Acceptance criteria (EARS)

### Token

- WHEN an account-manage token is minted, the system SHALL bind the contact's `contactId` and SHALL
  NOT require an email, so a Steam-only player with no email on file can still be issued a revoke
  link (DECISIONS §14).
- WHEN an account-manage token is minted, the system SHALL write `action: "account_manage"` into its
  own payload type and SHALL NOT call `generateUnsubscribeToken`.
- WHEN a token is validated, the system SHALL require `payload.action === "account_manage"` by VALUE
  and SHALL render the invalid-link page for any other value, including a token minted by
  `generatePreferenceCenterUrl` with `action: "manage"`. An email-footer preference-center link SHALL
  NOT unlock account revocation.
- WHEN an unsubscribe-shaped token (carrying `externalId` + `email`, no `contactId`) is presented,
  the system SHALL reject it, because the two payload types are structurally distinct.
- WHEN a token's signature does not verify, or the payload is malformed, or `exp` has passed, the
  system SHALL render the invalid-link page and SHALL NOT read `linked_accounts`.
- WHEN a token is minted, its TTL SHALL default to 7 days, shorter than the unsubscribe default of 30
  (`unsubscribe-tokens.ts:31`), because this token revokes identity links rather than toggling a
  mailing preference.

### GET: read-only, non-revealing

- WHEN `GET /v1/accounts/manage?token=` is requested with a valid token, the system SHALL render the
  live links for THAT token's contact only: provider display name, `username`, and linked date.
- WHEN the page is rendered, the system SHALL NOT display `providerUserId`, `contactId`, `version`,
  `method`, any sealed token, or any other contact's data — under any query parameter. There is no
  parameter on this route that can widen the result set beyond the token's contact.
- WHEN the token's contact has no live links, the system SHALL render the page with an empty-state
  message and SHALL NOT distinguish it from any other valid-token state.
- WHEN `GET` is requested, the system SHALL perform NO write: no unlink, no `account.unlinked`, no
  `provider.revoke()`, no hook. A link-preview prefetch or an email scanner following this URL SHALL
  leave state untouched.
- WHEN the page is served, the system SHALL send `Cache-Control: no-store` and
  `<meta name="robots" content="noindex">`.
- WHEN the token's `contactId` no longer resolves to a live contact, the system SHALL render the
  empty state rather than 404 or error — no existence oracle.

### POST: revoke

- WHEN `POST /v1/accounts/manage` is submitted, the body SHALL be exactly `{ token, provider }`. It
  SHALL NOT carry `providerUserId`, a per-row token, a row index, or any other row identifier.
- WHEN a valid token and a `provider` are submitted, the system SHALL unlink EVERY live link that
  token's contact holds for that provider with `reason: "player"`, each at its own new version inside
  PRD 03's advisory-locked transaction and each passing `expectContactId`, and SHALL re-render the
  page.
- WHEN the token's contact owns no live link for that provider, the system SHALL re-render the same
  page having mutated and emitted nothing. It SHALL NOT reveal whether any pair exists, and SHALL NOT
  respond 403 or 404.
- WHEN a hosted callback relinks the pair to a different contact between the render and the POST, the
  system SHALL NOT unlink the new owner's link: the store returns `not_owner` under the pair lock and
  the route counts it as nothing revoked.
- WHEN a revoke succeeds, the system SHALL emit exactly one `account.unlinked` with
  `reason: "player"`, the full current state payload of DECISIONS §8, and
  `dedupeKey = "al:<provider>:<uid>:v<version>"`.
- WHEN a revoke succeeds, the system SHALL call `provider.revoke()` best-effort: a throw or a timeout
  SHALL be logged and SHALL NOT roll back the local unlink or change the rendered result.
- WHEN a revoke succeeds, `afterUnlink` SHALL have fired exactly once per row, from PRD 03's store
  (DECISIONS §15.4). This route passes `hooks: container.accountLinkHooks` into `unlinkAccount` and
  invokes no hook itself.
- WHEN the same POST is replayed (double-submit, browser back-and-resubmit), the second attempt SHALL
  find no live link, SHALL emit nothing, and SHALL render the same page.

### Rate limit

- WHEN requests to `GET` or `POST /v1/accounts/manage` exceed the configured budget for a client IP,
  the system SHALL respond `429` and SHALL NOT validate the token or touch the database.
- WHEN Redis is unavailable, the limiter SHALL behave exactly as the engine's existing
  `createRateLimit` does on that path (no silent bypass introduced by this PRD).

### Rendering safety

- WHEN a `username` or a provider display name is rendered, the system SHALL write it via
  `textContent` from the JSON-embedded config (the PRD 10 `hostedPageShell` posture), and SHALL NOT
  interpolate it into the markup string.
- WHEN a `username` is `<img src=x onerror=alert(1)>` (a provider-supplied value, therefore attacker
  influenced), the page SHALL render it as visible literal text.

## Tasks

### T1 — The dedicated account-manage token
_Boundary:_ `packages/email`
_Depends:_ —

A NEW module, `packages/email/src/account-manage-tokens.ts`. It reuses the crypto and NOTHING else
(DECISIONS §3.3, §14):

```ts
export interface AccountManageTokenPayload {
  /** The contact's uuid. NOT externalId, NOT email — Steam yields neither. */
  contactId: string;
  /** Fixed literal. Validated BY VALUE, unlike the unsubscribe validator. */
  action: "account_manage";
  exp: number;
}

export function generateAccountManageToken(options: {
  secret: string;
  contactId: string;
  expiresInSeconds?: number;  // default 7 * 24 * 3600
  now?: Date;
}): string;

/** Throws InvalidTokenError. Requires action === "account_manage". */
export function validateAccountManageToken(opts: {
  token: string;
  secret: string;
  now?: Date;
}): AccountManageTokenPayload;
```

`toBase64Url`, `fromBase64Url` and `sign` are module-private in `unsubscribe-tokens.ts` (`:33`,
`:37`, `:41`). **Extract them, do not copy them**: move the three into
`packages/email/src/hmac-token.ts` and have both modules import from it, the same
generalize-rather-than-fork posture PRD 14 T3 takes with the AES sealer. A second private copy of an
HMAC construction is how one of them drifts. The `timingSafeEqual` compare and the `exp` check are
copied in BEHAVIOUR from `unsubscribe-tokens.ts:90-95` and `:113-116` and must stay constant-time
and expiry-checked.

`TokenAction`, `UnsubscribeTokenPayload`, `generateUnsubscribeToken` and `validateUnsubscribeToken`
are UNCHANGED by this PRD. Do not widen the union, do not relax the email requirement, do not add
the action-value check there. That validator's action-segregation weakness is real and is a separate
ticket (DECISIONS §14), deliberately out of this stack.

Add the URL helper beside `generatePreferenceCenterUrl` (`packages/email/src/unsubscribe-url.ts`):

```ts
export function generateAccountManageUrl(options: {
  baseUrl: string;
  secret: string;
  contactId: string;
  now?: Date;
  expiresInSeconds?: number;   // default 7 * 24 * 3600
}): string;   // `${baseUrl}/v1/accounts/manage?token=…`
```

Export both from `packages/email/src/index.ts`.

Tests (`packages/email/src/__tests__/account-manage-tokens.test.ts`, new):
- `mints and validates a contactId-keyed token`
- `mints a token for a contact with no email` (the Steam case, DECISIONS §14: the whole reason this
  token exists rather than the unsubscribe one)
- `generateAccountManageUrl points at /v1/accounts/manage and defaults to a 7 day TTL`
- `rejects a tampered signature`
- `rejects an expired token`
- `rejects a token whose action is "manage"` — mint one with the extracted `sign` helper over an
  `action: "manage"` payload and assert it is refused
- `an existing unsubscribe token still validates unchanged` (the anti-drift test for the extraction:
  without it, moving `sign`/`toBase64Url` could silently change the wire format and invalidate every
  live email footer)

### T2 — Strict validation at the route boundary
_Boundary:_ `packages/engine`
_Depends:_ T1

`packages/engine/src/routes/accounts/manage-token.ts`:

```ts
export function readAccountManageToken(opts: { token: string; secret: string }):
  | { ok: true; contactId: string }
  | { ok: false };
```

A thin non-throwing wrapper over T1's `validateAccountManageToken` so a route never has to
try/catch inline. The action-value check lives in T1 and is asserted again here, because this is the
guard the preference center does not have: `routes/email/preferences.ts:51-67` validates a token and
never inspects `payload.action`, so any valid unsubscribe/resubscribe token opens it. Do not copy
that shape, and do not fix it here either.

Tests (`apps/api/src/__tests__/accounts-manage-page.test.ts`):
- `accepts an account_manage token`
- `rejects a manage-action token (the email footer preference-center link)`
- `rejects an unsubscribe-action token`
- `rejects a tampered signature`
- `rejects an expired token`
- Mutation check: deleting the `action === "account_manage"` check must fail the second and third
  tests.

### T3 — `GET /v1/accounts/manage`
_Boundary:_ `packages/engine`
_Depends:_ T2

`packages/engine/src/routes/accounts/manage.ts`, an `OpenAPIHono<AppEnv>()` with a `createRoute`
GET in the shape of `routes/email/preferences.ts:23-45`. Flow:

1. Validate via `readAccountManageToken`; on failure render the invalid-link page and stop.
2. Confirm the token's `contactId` still names a live (not soft-deleted) contact, wrapped in
   try/catch in the posture of `preferences.ts:76-81` — a bookkeeping probe may never 500 the page.
   There is no key-to-contact resolve step here: the token already carries the contact id, which is
   the point of the dedicated payload.
3. Read live links via PRD 03's `listLiveLinksForContact({ contactId })`. Scoped by the token's
   contact id, full stop. There is no filter parameter on this route.
4. Render with PRD 10's `hostedPageShell`, config carrying `{ rows: [{ provider, providerLabel,
   username, linkedAt }] }` and a `bodyScript` that fills the rows via `textContent`.

   **There is no `revokeToken` and no `providerUserId` on a row.** An earlier draft had both, and the
   PRD was unbuildable as a result: the revoke POST needed `providerUserId` in the body while these
   acceptance criteria forbid that string appearing in the HTML at all, and `revokeToken` was named
   nowhere else in the entire stack (T1 defines only the contact-keyed `account_manage` token).
   Neither escape works against this renderer either, because `hostedPageShell` JSON-embeds `config`
   verbatim into the page, so anything in a row IS in the HTML and trips the same assertion.

   The resolution is PRD 09 T8b's already-locked semantics, verbatim: the form carries
   `{ token, provider }`, and the handler re-reads the token contact's live links server-side. The
   request body then cannot name a pair at all, so the ownership check is STRUCTURAL rather than
   asserted. For a `multiple: false` provider, the shape this ICP actually uses, that is one row
   anyway.

Mounted in `routes/index.ts` alongside the OPEN routes (`:44-47`), NOT inside any accounts guard.
`v1.route("/accounts", accountsRouter)` from PRD 09 T9 registers the literal `/manage` sub-route
first.

Tests (`apps/api/src/__tests__/accounts-manage-page.test.ts`):
- `lists the token contact's live links with provider, username and linked date`
- `renders an empty state for a contact with no links`
- `renders an empty state when the token's contactId resolves to nothing`
- `never renders providerUserId, contactId or version` (assert the strings are absent from the HTML)
- `cannot be widened by a query parameter` — issue the request with
  `?contactId=<other>&email=<other>&provider=…` and assert the rendered rows are unchanged.
- `a username containing markup renders as literal text`
- `sends Cache-Control: no-store and robots noindex`
- `GET performs no write` — seed one live link, GET the page twice, assert the link is still live,
  `version` unchanged, and zero `account.unlinked` emitted. This is the cold-connect
  "GET never binds" law (`cold-connect/index.ts:146-148`) applied here.
- `reaches the handler with no Authorization header` (proves no accounts guard shadows it)

### T4 — `POST /v1/accounts/manage` revoke
_Boundary:_ `packages/engine`
_Depends:_ T3

Same route file. Body: `{ token, provider }`, form-encoded (a hidden `token` input and one submit
button per provider row), so the page works with no JS. The handler:

1. Validate the token (T2). Invalid → invalid-link page.
2. Read the contact id straight off the token payload.
3. Enumerate that contact's live links for `provider` via
   `listLiveLinksForContact({ contactId })`. The body named no pair, so there is nothing to
   cross-check: a request cannot reference a link the token's contact does not hold.
4. For each, `unlinkAccount({ provider, providerUserId, reason: "player", expectContactId:
   tokenContactId, hooks: container.accountLinkHooks })` (PRD 03). `expectContactId` is REQUIRED, and
   it is not redundant with step 3: the enumeration ran outside the pair lock, so a hosted callback
   can relink the pair in the window between reading and writing, and without the guard this page
   then destroys the new owner's just-proven link. A `not_owner` result is counted as nothing
   revoked.
5. Best-effort `provider.revoke()` in a try/catch with `logger.warn`.
6. `emitOutbound` for `account.unlinked` per unlinked row, intent layer,
   `void … .catch(logger.warn)`, in the shape of `routes/groups/index.ts:380-388`, using PRD 08's
   `buildAccountUnlinkedPayload` / `buildDedupeKey`.
7. Re-render the page (POST-then-render; the token is still in the form so a refresh is idempotent by
   step 3 finding no live link). `afterUnlink` already fired inside step 4's await.

Tests (`apps/api/src/__tests__/accounts-manage-revoke.test.ts`):
- `revokes a live link owned by the token's contact and emits account.unlinked with reason "player"`
- `a POST naming a provider the token's contact has no link for is a silent no-op` — assert the
  ordinary page (not 403/404) and that nothing was emitted
- `contact B's link on the same provider is untouched by contact A's revoke` — seed a live link for
  contact B on the same provider, POST with contact A's token, assert B's link is still live with an
  unchanged `version` and that nothing was emitted. This is the GDPR criterion and it must be written
  first, failing. **Mutation guard:** making the handler resolve rows by `provider` alone across all
  contacts must fail it.
- `a revoke racing a relink does not unlink the new owner's link` — the `expectContactId` test.
  **Mutation guard:** dropping `expectContactId` from the call must fail it.
- `the POST body cannot name a providerUserId` — assert the handler ignores a supplied
  `providerUserId` field entirely (send one for a pair owned by another contact and assert it stays
  live)
- `a replayed revoke emits nothing the second time`
- `a throwing provider.revoke() does not roll back the unlink`
- `a throwing afterUnlink does not change the rendered result`
- `the emitted payload carries the full current state and a versioned dedupeKey`

### T5 — Rate limit
_Boundary:_ `packages/engine`
_Depends:_ T3

Register `createRateLimit({ prefix: "ratelimit:accounts-manage", max: 20, windowMs: 60_000,
keyFn: clientIpKey, disableInTest: false })` on `/accounts/manage` in `routes/index.ts`, BEFORE the
router. `clientIpKey` because the surface is unauthenticated and the default key collapses every
caller onto one `"anonymous"` bucket (`middleware/rate-limit.ts:16-21`). Register it ONCE on the
exact path — the double-registration bug documented at `routes/index.ts:144-148` halves the budget.

Tests (`apps/api/src/__tests__/accounts-manage-page.test.ts`):
- `429s past the per-IP budget`
- `a 429 does not validate the token or read the database` (assert with a spy / a token that would
  otherwise render rows)
- `two different client IPs have independent budgets`

### T6 — Changesets
_Boundary:_ `packages/email` then `packages/engine`
_Depends:_ T5

Minor changeset for `@hogsend/email` (the new account-manage token module + `generateAccountManageUrl`,
plus the internal HMAC-helper extraction, which is behaviour-preserving) and for `@hogsend/engine`
(the manage page).

## Seams

None. Provider `revoke()` is exercised through PRD 06's deterministic Fake; a real credential is not
required to prove best-effort semantics.

## Done when

- [ ] `accounts-manage-page.test.ts` and `accounts-manage-revoke.test.ts` are green, and each
      security assertion fails when its guard is removed.
- [ ] The cross-contact revoke test proves the page cannot touch or reveal another contact's link.
- [ ] The GET-never-mutates test proves a prefetch leaves state untouched.
- [ ] An `action: "manage"` email-footer token is rejected by the manage page.
- [ ] A player contact with NO email can be issued a working manage link (the Steam case).
- [ ] `packages/email/src/unsubscribe-tokens.ts` is unchanged apart from importing the extracted
      HMAC helpers: `TokenAction` still has three members, `validateUnsubscribeToken` still requires
      an email, and the anti-drift test proves an existing unsubscribe token still validates.
- [ ] The docs task (PRD 16) presents the userToken in-app revoke as the primary surface and this
      page as the no-session fallback (DECISIONS §14).
- [ ] The route reaches its handler with no `Authorization` header and is not shadowed by any
      `/v1/accounts` guard.
- [ ] Rate limit registered once, IP-keyed, active in tests.
- [ ] The revoke POST body is `{ token, provider }` only. `grep -n "providerUserId\|revokeToken"
      packages/engine/src/routes/accounts/manage.ts` returns nothing.
- [ ] Every `unlinkAccount` call from this route passes `expectContactId`, with the racing-relink
      test and its mutation guard.
- [ ] `grep -n "afterUnlink" packages/engine/src/routes/accounts/manage.ts` returns nothing: the
      store is the sole invoker.
- [ ] `accounts-manage-revoke.test.ts` seeds a webhook endpoint and counts deliveries, so it is
      appended to `WEBHOOK_FANOUT` in `apps/api/vitest.config.ts` with a comment (PRD 08 T4b's rule).
- [ ] Changesets added for `@hogsend/email` and `@hogsend/engine`.
- [ ] From the worktree root (DECISIONS §4):
      ```
      pnpm lint
      pnpm check-types
      cd apps/api && pnpm test
      ```
- [ ] Public-surface change in `@hogsend/email` and `@hogsend/engine`, so also: `pnpm build`.

## Implementation Notes
