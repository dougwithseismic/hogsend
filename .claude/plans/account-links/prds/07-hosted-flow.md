# PRD 07 — Hosted flow: state, start, callback

## Goal
Mount `GET /v1/accounts/:provider/start` and `GET /v1/accounts/:provider/callback`, the two public,
unauthenticated routes that turn a player's consent into a proven `LinkedIdentity` and hand it to the
PRD 03 store. Reuse the engine's existing signed-state format and the connector callback's hardening
verbatim. This is the security-critical PRD: everything else in the stack trusts that only a
completed callback here can move a link.

## Locked decisions specific to this PRD
- DECISIONS §3.3: add an `account_link` purpose to `ConnectorStateIntent`
  (`packages/engine/src/lib/connector-state.ts:27-39`). Do NOT invent a second token format.
- DECISIONS §3.3: apply the connector callback's hardening (verify-before-dispatch, cross-id replay
  rejection, Redis single-use nonce burn) to this callback. Source:
  `packages/engine/src/routes/connectors/index.ts:100-146`.
- DECISIONS §6.1: only a completed hosted callback may MOVE a link. This route is the ONLY
  displacement path in the whole system.
- DECISIONS §6.3: the authoritative contact is the one sealed into the state token, never the email
  the provider reports. The comment being generalized is
  `packages/plugin-discord/src/connector.ts:464-468`.
- DECISIONS §6.4: fold a provider email only when the provider marks it verified.
- DECISIONS §6.7: `beforeLink` is fail-closed. A throw, a timeout, or `{ allow: false }` rejects.
- DECISIONS §6.8: the public callback and the mint path are Redis-throttled, fail-closed.
- DECISIONS §8: `account.link_failed` never mints a contact.
- DECISIONS §9: `afterLink` runs BEFORE the success page renders, bounded at 5s, fail-open.
- **DECISIONS §15.4: this route invokes `beforeLink` and NOTHING ELSE.** `afterLink` / `afterUnlink`
  are invoked by PRD 03's store, once, post-commit. This route passes
  `hooks: container.accountLinkHooks` into `linkAccount` and awaits it, which is what makes
  "afterLink runs before the success page renders" true. It does not call an after-hook itself; doing
  so fires every customer hook twice, and because the hooks are documented at-least-once, nothing
  would fail loudly.
- **DECISIONS §6.10 + §15.1**: the cold-path contact resolve is THIS route's job, with an explicit
  clamped policy, and the route shapes here collide with PRD 09's data-plane guard. Both are spelled
  out below and neither may be left to a delivery agent's judgement.
- **DECISIONS §15.2: `mintAccountLinkUrl` returns an ENGINE-origin URL**,
  `<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<signed account_link state>`. The provider
  authorize URL is only ever a 302 target, never a value handed to a caller.
- PRD 01 froze the surface this route drives: `provider.authorizeUrl({ state, redirectUri,
  codeChallenge })`, `provider.handleCallback({ query, redirectUri, codeVerifier, fetchImpl })
  → LinkedIdentity`, `AccountLinkCallbackError { reason: "denied" | "exchange_failed" |
  "state_invalid" }`, `AccountLinkHooks`, `BeforeLinkContext` / `AfterLinkContext`, and
  `ACCOUNT_LINK_HOOK_TIMEOUT_MS = 5_000`. This route imports all of it and defines none of it. Note
  that `AccountLinkCallbackError.reason` is deliberately the `account.link_failed` reason union minus
  `"vetoed"`, so PRD 08's emit is `reason: err.reason` with no translation table.

## State: extending `ConnectorStateIntent`

`packages/engine/src/lib/connector-state.ts` today:

```ts
export interface ConnectorStateIntent {
  purpose: "install" | "member_link";
  connectorId: string;
  contactId?: string;
  email?: string;
  nonce: string;
}
```

becomes:

```ts
export interface ConnectorStateIntent {
  purpose: "install" | "member_link" | "account_link";
  /** Connector flows only. OPTIONAL now that account_link exists. */
  connectorId?: string;
  /** account_link only. The AccountLinkProvider meta.id this state was minted for. */
  providerId?: string;
  /** member_link + account_link (WARM) — the bound contact id (authoritative). */
  contactId?: string;
  /** member_link only. */
  email?: string;
  /** account_link COLD only — the browser anonymous key the link binds to. */
  anonymousId?: string;
  /** account_link only. Already allowlist-checked at MINT time; re-checked at use. */
  returnTo?: string;
  nonce: string;
}
```

Three notes the implementer must not skip:

1. `providerId` is a NEW field, not a reuse of `connectorId`. `BETTER_AUTH_SECRET` signs every state
   in the process (`connector-state.ts:58-70`), so a state minted for one surface is
   signature-valid on the other. A separate field means the two surfaces cannot be confused even by
   a naming collision, e.g. a future connector with id `"discord"` and an account-link provider with
   id `"discord"`.
2. Widening `connectorId` to optional is SAFE for the connector route: its check is
   `stateCheck.intent.connectorId !== id` (`routes/connectors/index.ts:121`), and `undefined !== id`
   is true, so an `account_link` state presented at a connector callback is already rejected. T2
   below makes that explicit rather than incidental.
3. `verifyConnectorState` needs no change. It already never throws and returns
   `{ valid: false, reason }` on every malformed input (`connector-state.ts:77-114`).

## Redis keys

| Key | Written by | Op | TTL | On failure |
| --- | --- | --- | --- | --- |
| `account_link:pkce:<nonce>` | `/start` | `SET … EX <ttl> NX` | `ACCOUNT_LINK_STATE_TTL_SECONDS` (900) | fail closed |
| `account_link:state:used:<nonce>` | `/callback` | `SET … EX 900 NX` | 900 | fail closed |
| `hogsend:al:throttle:start:<ip>` | `/start` | `INCR` + `EXPIRE` on first | 900 | fail closed |
| `hogsend:al:throttle:cb:<ip>` | `/callback` | `INCR` + `EXPIRE` on first | 900 | fail closed |
| `hogsend:al:throttle:contact:<contactId>` | `/start` (warm) | `INCR` + `EXPIRE` on first | 900 | fail closed |

The nonce-burn key deliberately mirrors `connector:state:used:<nonce>`
(`routes/connectors/index.ts:138-139`) byte-for-byte in shape, including the 900s TTL and the
`"OK"`-comparison on the `SET NX` result.

**Deliberate divergence from the connector route, and it must be commented in the code.** The
connector callback degrades to TTL-only validity when Redis is absent, on the stated principle that
it will "never block a callback on a cache miss" (`routes/connectors/index.ts:134-136`). The account
link callback does the OPPOSITE and fails closed, because DECISIONS §6.8 says so and because the
threat is different: a replayed connector install re-captures a guild id, whereas a replayed account
link can MOVE a platform account between contacts (DECISIONS §6.1). PKCE verifier custody also lives
in Redis, so for the OAuth2 providers Redis is structurally required regardless. `/v1/accounts/*`
therefore 503s with `{ error: "unavailable" }` when Redis is not connected, and the container logs
one boot warning when any account-link provider is registered while `getRedisIfConnected()` is null.

## Warm vs cold binding (DECISIONS §6.3)

| | WARM | COLD |
| --- | --- | --- |
| Minted by | `POST /v1/accounts/link-url` with a server-minted userToken (PRD 09), or `mintAccountLinkUrl` server-side. Both return an ENGINE-origin `/start?t=<state>` URL | `GET /v1/accounts/:provider/start?anonymous_id=…` from the browser, or `/start` with no key at all (the route mints one, below) |
| State carries | `contactId` (sealed, AUTHORITATIVE) | `anonymousId` only |
| Callback binds to | exactly that `contactId`. The provider-reported email is NEVER a resolution key | the anonymous key, through THIS route's clamped resolve (below). Never through the store, which takes an already-resolved id |
| Can displace a live owner | yes (proof of control was given) | **no** |
| Can attach to an identified contact | yes | **no.** Anonymous-only, or a fresh contact |

**Only the WARM path may displace, and only the WARM path may touch an identified contact**
(DECISIONS §6.10, narrowed 2026-08-13). The original "cold displaces too, proof is proof" reading is
wrong, because on the cold path the *proof* is of the platform account, not of the CONTACT. The
contact side of a cold link is an `anonymous_id` typed into an unauthenticated URL by whoever is
holding the browser, which is browser-readable by design and is not a secret
(`lib/contacts.ts:49-59`). Let a cold callback attach to any contact and an attacker with a genuinely
proven Steam account grafts it onto a victim's identified contact by pasting the victim's anon id.
That is precisely the write `contacts.ts:1338-1339` exists to refuse.

### The cold resolve, spelled out (DECISIONS §6.10)

This route owns it. PRD 03 does not have a resolve and must not grow one: `LinkAccountInput.contactId`
is an already-resolved `string`.

```ts
// COLD path only, run STRICTLY AFTER `beforeLink` allows and BEFORE linkAccount opens
// its pair-lock transaction. resolveOrCreateContact takes its OWN contact-key advisory
// locks (contacts.ts:1203/:1223), so calling it inside the pair lock reintroduces the
// exact deadlock `unlinkAccountInTx` exists to avoid.
const resolved = await resolveOrCreateContact({
  db,
  anonymousId,
  policy: {
    create: "on-miss",
    allowMerge: "anonymous-only",
    trustedKinds: ["anonymous"],
  },
});
```

All three `ResolvePolicy` fields are REQUIRED (`contacts.ts:529-572`), so all three are written out.
Do not omit them and inherit the default: the default is `allowMerge: "any"` with
`trustedKinds: ALL_IDENTITY_KINDS` (`contacts.ts:1146-1151`), which fills in links onto whatever
contact already owns that anon alias, including an identified victim's. That default is correct for
the server-side callers it was written for and catastrophic here.

**A `PublishableAnonymousMergeError` is a HARD REFUSAL.** Not a fallback, not a retry with a fresh
key, not "mint a new contact instead": no link row, no contact minted, no token sealed,
`account.link_failed { reason: "state_invalid" }`, the error page. The refusal is the correct
outcome, because the only way to reach it is an `anonymous_id` naming a contact that a cold flow may
not touch.

Named test, mutation-guarded:
`a cold callback whose anonymous_id names an IDENTIFIED contact writes no link row and mints nothing`
— seed an identified contact holding that anon alias, run a fully proven cold callback, then assert
zero new `linked_accounts` rows AND an unchanged `contacts` row count. **Mutation guard:** relaxing
`allowMerge` to `"any"` must make it fail. A test that only checks the response status passes
happily while the graft lands.

### `/start` mints the anonymous key when the browser has none

A cold `/start` with no `anonymous_id` is NOT a 400. The route mints one
(`randomBytes(16).toString("base64url")`, the same shape the browser SDK uses), seals it into the
state, and sets it as a first-party cookie on the 302 so the browser carries the same key afterwards.

This is load-bearing rather than a convenience: Steam yields no email, ever, and DECISIONS §7 forbids
widening `IdentityKind` to a `steam` kind, so an `anonymous_id` is the ONLY thing a cold Steam link
can key its contact on. Without the mint, a cold link is keyless and there is literally nothing to
create a contact with. Minting server-side also keeps the key out of the attacker's hands for the
no-key case, which is the common one.

A cold `/start` that DOES supply an `anonymous_id` uses it, and eats the clamped-resolve refusal
above if it names a contact it may not touch.

**Cold Steam is the sharp case and needs its own callout in the code.** Steam yields no email, ever
(PRD 06). So a cold Steam link has NO identity beyond the browser anonymous key: the resulting
contact is anon-keyed and stays that way until the player identifies, at which point
`adoptOrphanHistory` stamps their anon-keyed history rows.

**The link row itself needs nothing from that path, and this is worth knowing before someone goes
looking for a bug.** `adoptOrphanHistory` stamps rows matching
`WHERE user_id = :key AND contact_id IS NULL`; `linked_accounts` has no `user_id` column and its
`contact_id` is `NOT NULL`, so it is a PROVEN NO-OP there (DECISIONS §7, PRD 04 T3). The link
survives identification anyway, by both routes: if the anon contact is stamped in place, the link
row already points at the surviving row; if the anon contact is MERGED into an existing one, PRD
04's merge leg repoints `linked_accounts.contact_id`. The merge leg carries the whole invariant.

One consequence to implement rather than discover: a cold Steam callback mints a contact
(`create: "on-miss"`), and that is legitimate. A proven platform-account link is an identity
assertion, not an observation, so the ghost-contact rule from the ingest path
(`resolveContactNoCreate`) does NOT apply here. Comment it at the site so it is not later "fixed".
The clamp that keeps this honest is `allowMerge: "anonymous-only"`, not a refusal to create.

## Acceptance criteria (EARS)

### `GET /v1/accounts/:provider/start`
- WHEN `:provider` is not in `client.accountLinkProviders`, the system SHALL 404 and SHALL NOT mint a
  state.
- WHEN the IP throttle is exceeded, the system SHALL 429 and SHALL NOT mint a state.
- WHEN Redis is unavailable, the system SHALL 503 and SHALL NOT mint a state (fail closed).
- WHEN a `return_to` query param is supplied whose origin is not in
  `client.accountLinkAllowedOrigins`, the system SHALL 400 with `{ error: "return_to_not_allowed" }`
  and SHALL NOT mint a state.
- WHEN neither a sealed warm token (`?t=`) nor an `anonymous_id` is present, the system SHALL MINT a
  fresh `anonymousId`, seal it into the state as a COLD binding, and set it as a first-party cookie
  on the 302 response. It SHALL NOT 400. Steam yields no email and `IdentityKind` is not widened, so
  without this a cold link has no key at all and cannot complete.
- WHEN a `?t=` warm state is presented, the system SHALL verify its signature, TTL, `purpose` and
  `providerId` exactly as the callback does, and SHALL 400 on any failure. A `?t=` that fails
  verification is NOT silently downgraded to a cold link.
- WHEN neither 401 nor 403 is warranted by this route's own checks, the system SHALL NOT return
  either: `/start` and `/callback` carry no `Authorization` header by construction, so any 401/403
  from them is a middleware collision (see "Route shape" below), not a flow decision.
- WHEN the resolved provider declares `capabilities.pkce`, the system SHALL generate a 43-to-128 char
  RFC 7636 verifier, store it at `account_link:pkce:<nonce>` with `SET NX EX`, and send the S256
  challenge on the authorize URL. The verifier SHALL NEVER appear in the state token, in the redirect
  URL, or in a log line.
- WHEN the provider does not declare `capabilities.pkce` (Steam), the system SHALL skip the PKCE mint
  entirely and SHALL NOT write `account_link:pkce:<nonce>`.
- WHEN all checks pass, the system SHALL 302 to the provider's authorize URL carrying the signed
  state.

### `GET /v1/accounts/:provider/callback`
- WHEN the callback carries no `state`, an unsigned state, a tampered state, or an expired state, the
  system SHALL 400, SHALL NOT exchange a code, SHALL NOT call `beforeLink`, and SHALL emit
  `account.link_failed` with `reason: "state_invalid"` and `contactId: null`.
- WHEN the state's `purpose` is not `"account_link"`, the system SHALL 400 before any exchange.
- WHEN the state's `providerId` does not equal the route's `:provider`, the system SHALL 400 before
  any exchange (cross-provider state replay).
- WHEN the state's nonce has already been burned, the system SHALL 400 before any exchange (replay).
- WHEN Redis is unavailable at the burn, the system SHALL 400 (fail closed), NOT proceed.
- WHEN the provider reports a user denial (`error=access_denied`, or Steam's
  `openid.mode=cancel`), the system SHALL burn the nonce, emit `account.link_failed` with
  `reason: "denied"`, and render the error page. It SHALL NOT emit `state_invalid`.
- WHEN `provider.handleCallback` throws an `AccountLinkCallbackError`, the system SHALL emit
  `account.link_failed` carrying `err.reason` verbatim and SHALL NOT write to `linked_accounts`.
- WHEN `provider.handleCallback` throws anything else, the system SHALL emit `account.link_failed`
  with `reason: "exchange_failed"` and SHALL log the error without its body.
- WHEN identity is proven, the system SHALL invoke `beforeLink` BEFORE any `linked_accounts` write.
- WHEN `beforeLink` throws, times out at 5s, or returns `{ allow: false }`, the system SHALL NOT
  write to `linked_accounts`, SHALL discard every token obtained during the exchange without sealing
  or persisting it, SHALL emit `account.link_failed` with `reason: "vetoed"`, and SHALL render the
  error page.
- WHEN `beforeLink` is not configured, the system SHALL proceed as if it returned `{ allow: true }`.
- WHEN the link commits, the system SHALL invoke `afterLink` bounded at 5s and fail-open, and SHALL
  render the success page even if `afterLink` throws or times out.
- WHEN a `returnTo` rode the state, the system SHALL re-check it against
  `client.accountLinkAllowedOrigins` at redirect time and SHALL fall back to the hosted success page
  if the allowlist has since changed.
- WHEN the returned `LinkedIdentity` carries a `verifiedEmail`, the system SHALL pass it to PRD 03 as
  a contact PROPERTY and a possible MATCH, never as a merge key (DECISIONS §6.4, tightened), and
  WHEN it carries only `properties.<provider>_email` the system SHALL pass that through as a display
  property and SHALL NEVER use it as a resolution key.
- WHEN the callback is COLD, the system SHALL resolve the contact with
  `policy: { create: "on-miss", allowMerge: "anonymous-only", trustedKinds: ["anonymous"] }`,
  strictly AFTER `beforeLink` allows and BEFORE `linkAccount` opens its transaction.
- WHEN that resolve throws `PublishableAnonymousMergeError`, the system SHALL write no link row, mint
  no contact, seal no token, emit `account.link_failed { reason: "state_invalid" }`, and render the
  error page.
- WHEN the callback is COLD and a live owner already exists for the pair, the system SHALL pass
  `allowDisplaceLiveOwner: false` and report the store's `live_owner_conflict` on the error page.
  Only the WARM path passes `true`.
- WHEN a successful `linkAccount` returns, the system SHALL emit `account.linked` from THIS route
  (the intent layer) using the facts the store returned, including its `owner` block. The store never
  emits (DECISIONS §8, and the `lib/groups.ts` precedent).
- WHEN a link completes, the system SHALL invoke `afterLink` EXACTLY ONCE, and that invocation SHALL
  come from PRD 03's store, not from this route (DECISIONS §15.4).

## Tasks

### T1 — `account_link` state purpose
_Boundary:_ `packages/engine`
_Depends:_ —

Edit `packages/engine/src/lib/connector-state.ts`: widen the `purpose` union, make `connectorId`
optional, add `providerId` / `anonymousId` / `returnTo`. Extend the file header comment with a
third bullet for `purpose: "account_link"` describing what it binds, in the voice of the existing
two bullets at `:11-17`.

Tests `packages/engine/src/lib/connector-state.account-link.test.ts`:
- `signs and verifies an account_link intent round-trip`
- `a tampered payload fails with bad_signature`
- `an expired account_link state fails with expired`
- `the existing install/member_link round-trips are unchanged`

### T2 — Harden the connector route against a cross-surface state
_Boundary:_ `packages/engine`
_Depends:_ T1

In `packages/engine/src/routes/connectors/index.ts`, immediately after the state verify at `:106-116`
and before the connectorId check at `:121`, add an explicit purpose allowlist:

```ts
if (stateCheck.intent.purpose !== "install" && stateCheck.intent.purpose !== "member_link") {
  logger.warn("connector oauth callback: unsupported state purpose", { connectorId: id, purpose: stateCheck.intent.purpose });
  return c.json({ error: "Invalid state" }, 400);
}
```

The `connectorId !== id` check already rejects an `account_link` state incidentally, and
`plugin-discord`'s handler has its own exhaustive fall-through at `connector.ts:494-500`. Neither is
an explicit statement of the rule at the dispatcher, and defence that depends on a plugin's `else`
branch is defence that a new plugin can drop.

Test `apps/api/src/__tests__/connectors-oauth-state-purpose.test.ts`:
- `an account_link state is rejected at the connector oauth callback`
- MUTATION GUARD: removing the purpose check must leave the test failing (the `connectorId`
  undefined-mismatch is asserted separately so the two guards are not aliased).

### T3 — Throttle + Redis preconditions
_Boundary:_ `packages/engine`
_Depends:_ —

New file `packages/engine/src/lib/account-link-throttle.ts`, modelled on
`packages/engine/src/cold-connect/throttle.ts`:

```ts
export type ThrottleResult = { ok: true } | { ok: false; reason: "rate_limited" | "redis_unavailable" };
export async function checkAccountLinkThrottle(args: {
  surface: "start" | "callback";
  ip: string;
  contactId?: string;
  config?: { windowSeconds?: number; max?: number };
}): Promise<ThrottleResult>;
```

Reuse the `bump()` idiom verbatim (`cold-connect/throttle.ts:28-36`): `INCR`, set the TTL on the
first increment only, throw on a null redis so the caller fails closed. Defaults: window 900s,
max 20 for `start`, max 20 for `callback`. Both budgets are per-IP; the warm path adds a per-contact
budget.

Tests `packages/engine/src/lib/account-link-throttle.test.ts` (fake redis):
- `allows under the cap`
- `rejects over the cap with rate_limited`
- `rejects with redis_unavailable when redis is null` (the fail-closed guard)
- `sets the TTL exactly once, on the first increment`

### T4 — PKCE custody
_Boundary:_ `packages/engine`
_Depends:_ —

New file `packages/engine/src/lib/account-link-pkce.ts`:

```ts
export function generatePkcePair(): { verifier: string; challenge: string }; // S256, node:crypto
export async function storePkceVerifier(nonce: string, verifier: string, ttlSeconds: number): Promise<boolean>;
export async function takePkceVerifier(nonce: string): Promise<string | null>; // GETDEL, single-use
```

`takePkceVerifier` uses `GETDEL` so the verifier is consumed exactly once even if the nonce burn is
somehow bypassed. `storePkceVerifier` uses `SET NX` and returns false when the key already exists,
which the `/start` route treats as a nonce collision and a 500.

Tests `packages/engine/src/lib/account-link-pkce.test.ts`:
- `the challenge is the base64url SHA-256 of the verifier`
- `the verifier length is within RFC 7636 bounds`
- `takePkceVerifier returns the verifier once and null thereafter`
- `storePkceVerifier refuses to overwrite an existing nonce`

### T5 — `GET /v1/accounts/:provider/start`
_Boundary:_ `packages/engine`
_Depends:_ T1, T3, T4, 05, 06

New file `packages/engine/src/routes/accounts/start.ts`, plus
`packages/engine/src/routes/accounts/index.ts` registering the router.

#### Route shape: mounting these does NOT put them outside the api-key data plane

**Read this before writing the mount.** An earlier draft mounted `/start` and `/callback` on `app`
rather than `v1`, believing that escaped the api-key middleware. It does not. `app.route("/v1", v1)`
FLATTENS `v1`'s middleware into the same router, and **Hono runs every matching `use`**. PRD 09's
data-plane guard is registered on the two-segment param pattern `/accounts/:provider/:providerUserId`,
which also matches `/accounts/steam/start` and `/accounts/steam/callback`. As originally specified,
both of these routes 401'd on `requireApiKey` with no `Authorization` header, and the entire hosted
OAuth flow was dead. The repo already documents the rule at `routes/index.ts:90` and `:118-127`.

DECISIONS §15.1 settles it: **PRD 09 registers ONE guard on that pattern that branches internally**,
falling through with NO guard when the second segment is `start` or `callback` (and short-circuiting
to `requirePublishableOrIngest` when the first segment is `me`), mirroring the method-branching
`/contacts` guard at `routes/index.ts:89-109`. PRD 07 mounts its routes on `v1` next to the rest of
the accounts router and does not try to dodge the middleware by choosing a different mount point.

Every route here therefore needs a test asserting it is **neither 401 nor 403**:

- `GET /v1/accounts/steam/start with no Authorization header is neither 401 nor 403`
- `GET /v1/accounts/steam/callback with no Authorization header is neither 401 nor 403`

each with a **mutation check**: restoring the blanket
`v1.use("/accounts/:provider/:providerUserId", requireApiKey, requireScope("accounts"))` must make
them fail. A test asserting only "not 401" ships the broken route green, because the 403 arrives from
the scope check rather than the key check.

#### `mintAccountLinkUrl` returns an ENGINE-origin URL (DECISIONS §15.2)

Export the server-side minter from `packages/engine/src/lib/account-link-url.ts` (DECISIONS §2 names
it). It returns:

```
<API_PUBLIC_URL>/v1/accounts/<provider>/start?t=<signed account_link state>
```

and `/start` accepts that pre-sealed `t` as its WARM binding. It does NOT return the provider's
authorize URL. **The provider authorize URL is only ever a 302 target, never a value handed to a
caller.**

This is not tidiness. PRD 13 derives its `postMessage` `expectedOrigin` from whatever this returns
(`new URL(url).origin`), so returning `https://steamcommunity.com/...` would make the embed silently
drop every success message and time out with `AccountLinkTimeoutError` while the link had committed
server-side. PRD 13's fake-`Window` tests cannot detect that, so the invariant has to be pinned here
and asserted there. PRD 09's `POST /v1/accounts/link-url` returns exactly this value.

Test: `mintAccountLinkUrl returns an API_PUBLIC_URL-origin /start URL carrying a verifiable state` —
assert `new URL(url).origin === new URL(env.API_PUBLIC_URL).origin`, that the path is
`/v1/accounts/<provider>/start`, and that `verifyConnectorState(url.searchParams.get("t"))` returns
`valid: true` with the sealed `contactId`.

Order of operations, and it is the order that is being tested:
1. resolve provider from `c.get("container").accountLinkProviders` (404 on miss)
2. `getRedisIfConnected()` (503 on null)
3. throttle (429)
4. `return_to` allowlist (400)
5. warm/cold binding resolution: a `?t=` state is verified (signature, TTL, `purpose`, `providerId`)
   and its sealed `contactId` becomes the WARM binding, 400 on any failure; otherwise the
   `anonymous_id` query param is the COLD binding; otherwise MINT one and set the cookie. No 400 for
   a missing key
6. mint `nonce` (`randomBytes(16).toString("base64url")`)
7. PKCE mint when `capabilities.pkce`
8. `signConnectorState({ purpose: "account_link", providerId, contactId?, anonymousId?, returnTo?, nonce }, env.BETTER_AUTH_SECRET, env.ACCOUNT_LINK_STATE_TTL_SECONDS)`
9. 302 to `await provider.authorizeUrl({ state, redirectUri, codeChallenge })` (PRD 01's
   `AuthorizeUrlArgs`; the return type is `string | Promise<string>`, so await it)

For Steam there is no `state` query param in OpenID 2.0: the preset appends the state to
`openid.return_to`, and it comes back as `?state=` on the callback URL, so step 4 of T6 reads
`query.state` unchanged for both protocols.

### T6 — `GET /v1/accounts/:provider/callback`
_Boundary:_ `packages/engine`
_Depends:_ T5, 03

New file `packages/engine/src/routes/accounts/callback.ts`. Order of operations, mirroring
`routes/connectors/index.ts:100-159` step for step:

1. resolve provider (404)
2. `getRedisIfConnected()` (503)
3. callback throttle (429)
4. `verifyConnectorState(query.state ?? "", env.BETTER_AUTH_SECRET)`, and on `!valid` log with the
   returned `reason` and emit `link_failed{state_invalid}` then 400. This happens BEFORE anything
   else, exactly as the connector route does it, with the same "verify BEFORE dispatching" comment
   (`:100-105`)
5. `intent.purpose !== "account_link"` (400)
6. `intent.providerId !== :provider` (400, cross-provider replay). Log both ids, mirroring `:121-127`
7. nonce burn: `redis.set(\`account_link:state:used:${intent.nonce}\`, "1", "EX", 900, "NX")`, reject
   unless the result is `"OK"`. Mirrors `:136-146` except that a null redis here is a REJECT, not a
   bypass
8. `takePkceVerifier(intent.nonce)` when `provider.capabilities?.pkce`, and reject when null
9. `provider.handleCallback({ query, redirectUri, codeVerifier, fetchImpl })` → `LinkedIdentity`.
   The preset itself maps `error=access_denied` and `openid.mode=cancel` to
   `AccountLinkCallbackError{denied}` (PRD 01 T3/T4), so this route does NOT sniff for a denial
   itself. It catches, reads `err.reason` when the error is an `AccountLinkCallbackError`, falls back
   to `"exchange_failed"` otherwise, emits `account.link_failed` with that reason, and renders the
   error page
10. **`beforeLink`** (T7). On the cold path `ctx.contactId` is `null` and `ctx.anonymousId` is the
    key. No contact has been resolved yet, deliberately: the veto must not leave a contact behind.
11. **Contact resolution.** WARM: the sealed `contactId`, used as is. COLD: the clamped
    `resolveOrCreateContact` from the section above, run HERE, after the veto and outside every store
    transaction. A `PublishableAnonymousMergeError` is a hard refusal (`link_failed{state_invalid}`,
    error page, nothing written).
12. PRD 03 `linkAccount({ db, provider, identity, contactId, method: "oauth", multiple,
    onConflict, storeTokens, allowDisplaceLiveOwner, hooks })` — PRD 03's frozen `LinkAccountInput`,
    field for field. Note what it is NOT: not `providerId`, not `contactId | anonymousId`, and none
    of the four required policy fields may be omitted. `multiple` / `onConflict` / `storeTokens` come
    from the resolved provider definition (the CALLER applies the defaults `true` / `"replace"` /
    `capabilities.tokens === true`); `allowDisplaceLiveOwner` is `true` on the WARM path and `false`
    on the COLD path (DECISIONS §6.10). `hooks` is `container.accountLinkHooks`, which is how
    `afterLink` runs — this route does not call it.
13. emit `account.linked` from the returned facts (PRD 08's payload builder, this route's call site)
14. render the success page (PRD 10) or 302 to the re-checked `returnTo`. `afterLink` has already run
    inside step 12's await, so "you now have your reward" is true when the player reads it.

Tests `apps/api/src/__tests__/accounts-callback.test.ts`, each named for the attack it closes:
- `rejects a forged state (bad signature) without exchanging a code`
- `rejects a replayed state (second callback with the same nonce)`
- `rejects a cross-provider state (minted for steam, presented at /twitch/callback)`
- `rejects an expired state`
- `rejects a state whose purpose is member_link`
- `rejects when redis is unavailable at the nonce burn`
- `never calls provider.handleCallback when the state check fails` (asserted on the Fake's `calls` array,
  which is what makes "no code exchange" a real assertion rather than a hope)
- `emits account.link_failed with reason state_invalid and contactId null on a forged state`
- `binds to the sealed contactId and NOT to the provider-reported email` (the grafting test: the
  Fake returns an email belonging to a DIFFERENT existing contact, and the link must land on the
  sealed one)
- `a cold Steam callback with no email binds to the anonymous key`
- `a cold start with no anonymous_id mints one and sets it as a cookie` (assert the 302 carries a
  `Set-Cookie`, and that the sealed state's `anonymousId` matches the cookie value)
- `a cold callback whose anonymous_id names an IDENTIFIED contact writes no link row and mints
  nothing` — the DECISIONS §6.10 graft test. Count `linked_accounts` AND `contacts` before and after.
  **Mutation guard:** relaxing the resolve policy's `allowMerge` to `"any"` must make it fail
- `a cold callback cannot displace a live owner` (assert `allowDisplaceLiveOwner: false` reaches the
  store, and that an existing live link on another contact survives)
- `a warm callback CAN displace a live owner`
- `GET /v1/accounts/steam/start with no Authorization header is neither 401 nor 403`
- `GET /v1/accounts/steam/callback with no Authorization header is neither 401 nor 403` — both with
  the mutation check described in T5's Route-shape section
- `a successful callback invokes afterLink exactly once` (count invocations; this is the end-to-end
  half of DECISIONS §15.4, PRD 03 T6 owns the unit half)
- `the route emits exactly one account.linked` (count `webhook_deliveries` rows for a seeded
  endpoint, not "at least one")

### T7 — `beforeLink`, fail-closed
_Boundary:_ `packages/engine`
_Depends:_ T6, 05

New file `packages/engine/src/lib/account-link-hooks.ts`:

```ts
import { ACCOUNT_LINK_HOOK_TIMEOUT_MS, type AccountLinkHooks,
         type BeforeLinkContext } from "@hogsend/core";

export async function runBeforeLink(args: {
  hooks: AccountLinkHooks;
  ctx: BeforeLinkContext;
  logger: Logger;
}): Promise<{ allow: true } | { allow: false; reason: "vetoed" }>;
```

**`runBeforeLink` is the ONLY export of this file.** There is deliberately no `runAfterHook` here:
`afterLink` / `afterUnlink` have exactly one invoker, PRD 03's store, post-commit (DECISIONS §15.4).
The veto is genuinely route-owned because it is pre-write and this route is the only pre-write
position; the after-hooks are not, and a second implementation of them here is how they end up firing
twice. If a bounded fail-open runner is wanted for the store, it lives in `lib/account-links.ts`.

`runBeforeLink` races the hook against `ACCOUNT_LINK_HOOK_TIMEOUT_MS` (5000, defined once in
`@hogsend/core` by PRD 01 T2 so the engine and the docs quote ONE number). Throw, timeout and
`{ allow: false }` all collapse to `{ allow: false, reason: "vetoed" }`. A `void` return is an
ALLOW, per PRD 01's `Promise<{ allow: boolean; reason?: string } | void>` signature: a hook that only
wants to observe should not have to remember to return. There is no third outcome and no config flag
that turns the veto into a warning, because DECISIONS §6.7 says a veto hook that fails open is not a
veto hook.

The fail-open sibling posture (at-least-once, idempotency required of the consumer, a throw logged
and swallowed, never blocking the commit or the page) is implemented once, in PRD 03 T6, following
`packages/engine/src/cold-connect/index.ts:222-234`.

**Token discard on veto.** The tokens obtained in step 9 (`identity.tokens`) exist only as a local
`const` in the
callback handler and are passed to `linkAccount` only after `beforeLink` allows. On a veto the
handler returns before the store call, so nothing is sealed and nothing is written. Add an explicit
comment saying this is load-bearing, plus the test below, so a future refactor that hoists the seal
above the hook is caught.

Tests `packages/engine/src/lib/account-link-hooks.test.ts` + `apps/api/src/__tests__/accounts-before-link.test.ts`:
- `a throwing beforeLink vetoes`
- `a beforeLink that never resolves vetoes at 5s`
- `an { allow: false } beforeLink vetoes`
- `an absent beforeLink allows`
- `a beforeLink returning void allows`
- `a synchronous (non-promise) beforeLink is honoured`
- `a veto writes no linked_accounts row`
- `a veto persists no token material` (asserted against the store spy, not by reading the DB, so it
  is true even for Steam which has no tokens)
- `a veto emits account.link_failed with reason vetoed`
- `a vetoed cold callback creates no contacts row` (count the table; this is what pins "the veto runs
  before the resolve")
- `beforeLink on a cold callback sees contactId null and anonymousId set`
- `a throwing afterLink still renders the success page`
- `an afterLink that hangs is abandoned at 5s and the page still renders`

The last two exercise PRD 03's runner through this route; they assert the page, not the invoker.
`grep -n "afterLink\|afterUnlink" packages/engine/src/routes/accounts/` must return nothing.

### T8 — Changeset
_Boundary:_ `packages/engine`
_Depends:_ T1 to T7

Minor changeset for `@hogsend/engine`. Note the `ConnectorStateIntent` widening in the changeset body:
it is source-compatible for every existing caller (a new optional field plus a widened union), but it
is a public type change and consumers reading `intent.connectorId` now get `string | undefined`.

## Seams
Same as PRD 06: the two sets of real credentials (Steam, Twitch). Every task here is green against
the PRD 06 Fakes, which is the point of building them first. Mark `[~]` and continue to PRD 08 if
credentials have not landed.

## Done when
- [ ] `ConnectorStateIntent` carries `purpose: "account_link"` with `providerId` / `anonymousId` /
      `returnTo`, and the existing connector round-trips still pass.
- [ ] The connector route explicitly rejects a non-connector purpose, with a mutation-guarded test.
- [ ] `/start` and `/callback` return neither 401 nor 403 with no `Authorization` header, each with a
      mutation check proving the test fails if PRD 09's blanket param guard is restored.
- [ ] `mintAccountLinkUrl` returns an `API_PUBLIC_URL`-origin `/v1/accounts/<provider>/start?t=…`
      URL, asserted by a test. It never returns a provider authorize URL.
- [ ] The COLD resolve is spelled out with all three `ResolvePolicy` fields, runs after the veto and
      outside every store transaction, and `PublishableAnonymousMergeError` is a hard refusal, pinned
      by the mutation-guarded graft test.
- [ ] A cold `/start` with no key mints an `anonymousId` and sets the cookie; it does not 400.
- [ ] The COLD path passes `allowDisplaceLiveOwner: false`; only WARM passes `true`.
- [ ] The `linkAccount` call matches PRD 03's frozen `LinkAccountInput` field for field.
- [ ] `grep -rn "afterLink\|afterUnlink" packages/engine/src/routes/accounts/` returns nothing, and
      `a successful callback invokes afterLink exactly once` passes.
- [ ] The callback verifies the state BEFORE any code exchange, provably (asserted on the Fake's
      call log).
- [ ] Forged, replayed, cross-provider, expired and wrong-purpose states each have a named failing
      test that passes.
- [ ] The nonce burn uses `SET NX EX 900` and rejects when redis is unavailable.
- [ ] PKCE verifiers live only in Redis, are `GETDEL`-consumed, and appear in no log or URL.
- [ ] `beforeLink` vetoes on throw, timeout and `{ allow: false }`, writes nothing, persists no
      tokens, and emits `account.link_failed{vetoed}`.
- [ ] `afterLink` is bounded at 5s and fail-open, and the success page renders regardless.
- [ ] `returnTo` is allowlist-checked at mint AND at redirect.
- [ ] Changeset added for `@hogsend/engine`.
- [ ] `pnpm lint`
- [ ] `pnpm check-types`
- [ ] `cd apps/api && pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm --filter @hogsend/engine test`

## Implementation Notes
