# PRD 01 — Provider contract + presets (`@hogsend/core`)

## Goal
Ship the `AccountLinkProvider` contract, the `LinkedIdentity` shape, the `AccountLinkHooks`
postures and `defineAccountLink()` into `@hogsend/core`, plus the two preset factories
`oauth2Link()` and `steamOpenIdLink()`. Types and pure functions only, zero DB and zero engine
imports, so a third party can author a provider in their own repo with nothing but `@hogsend/core`.
After this PRD the shape of a provider is settled and PRDs 05, 06, 07 and 14 can be written
against a frozen surface.

## Locked decisions specific to this PRD

- Naming is settled by DECISIONS §2: the factory is `defineAccountLink()`, the one-per-contact
  policy is `multiple: true | false` (default `true`), the contested-link policy is
  `onConflict: "replace" | "reject"` (default `"replace"`, meaningful only when
  `multiple: false`). Do not reintroduce `cardinality` or `defineOAuthLink`.
- Location is settled by DECISIONS §3.1: this file tree only. Providers are NOT plugin packages;
  the two concrete providers (Steam, Twitch) live in the ENGINE (PRD 06), not here and not in
  `packages/plugin-*`. Discord is deliberately OUT of v1 (DECISIONS §12): it already links through
  `plugin-discord`, and this contract must not grow a second writer for it.
- Hook postures are settled by DECISIONS §9 and are part of the TYPE DOC, not just prose:
  `beforeLink` blocking, 5s, fail-closed; `afterLink` / `afterUnlink` post-commit, at-least-once,
  fail-open, bounded 5s.
- Security invariants that this contract must make expressible, from DECISIONS §6: the
  authoritative contact comes from the signed state (§6.3), a provider email is folded in ONLY
  when the provider marks it verified (§6.4).
- Token custody per DECISIONS §10: a provider declares whether it holds tokens. Steam stores
  nothing.
- House style for a provider contract is `packages/core/src/providers/email.ts:656-708` and
  `packages/core/src/providers/sms.ts:139-182`: a `meta` block, an optional `capabilities` block,
  method members, and a trailing identity factory (`defineEmailProvider`, `defineSmsProvider`)
  that returns its argument unchanged. Mirror it. `meta` is REQUIRED here, like
  `SmsProviderMeta` (`sms.ts:111-115`) and unlike the back-compat-optional
  `EmailProvider.meta` (`email.ts:664`) — account links have no legacy providers to protect.

## Acceptance criteria (EARS)

- WHEN a developer calls `defineAccountLink(provider)` with a well-formed provider, the system
  SHALL return that provider unchanged, typed as `AccountLinkProvider`.
- WHEN `defineAccountLink` receives a `meta.id` that is not `/^[a-z][a-z0-9_-]{0,31}$/`, the
  system SHALL throw at definition time naming the offending id.
- WHEN `defineAccountLink` receives a `meta.id` present in `RESERVED_ACCOUNT_LINK_IDS`, the system
  SHALL throw at definition time and name the reserved id.
- WHEN `defineAccountLink` receives `onConflict` while `multiple` is `true` (or omitted, which
  defaults to `true`), the system SHALL throw, because `onConflict` is meaningful only under
  `multiple: false` (DECISIONS §2).
- WHEN `defineAccountLink` receives a `refresh` or `revoke` function while
  `capabilities.tokens` is not `true`, the system SHALL throw, because a provider that stores no
  tokens has nothing to refresh or revoke.
- WHEN `defineAccountLink` receives `sync` whose `every` is not a positive duration, the system
  SHALL throw (the guard is `durationToMs(every) > 0`). A zero or negative minimum age makes the
  cron's `WHERE synced_at < now() - :every` predicate match every row on every tick, which is a
  stampede on the platform's API, not a configuration.
- WHEN `defineAccountLink` receives `sync` without a `read` function, the system SHALL throw.
- WHEN a provider's `handleCallback` resolves, the system SHALL guarantee (by type) that
  `providerUserId` is a non-empty string and that `verifiedEmail`, when present, was marked
  verified by the platform.
- WHEN `oauth2Link()` is called with a config declaring `usePkce: true`, the returned provider's
  `authorizeUrl` SHALL include `code_challenge` and `code_challenge_method=S256` and its
  `handleCallback` SHALL send `code_verifier` on the token exchange.
- WHEN `oauth2Link()` is called with a config declaring `userInfo.headers`, the returned provider's
  `handleCallback` SHALL send every one of those headers on the userinfo request alongside the
  `Authorization: Bearer` header. Twitch's Helix API rejects any request without a `Client-Id`
  header, so without this the preset cannot express Twitch at all and PRD 06 would have to fork a
  bespoke provider for it.
- WHEN `oauth2Link()`'s `handleCallback` receives a query carrying `error=access_denied`, the
  system SHALL throw `AccountLinkCallbackError` with `reason: "denied"`.
- WHEN the token exchange or the userinfo fetch returns a non-2xx status, the system SHALL throw
  `AccountLinkCallbackError` with `reason: "exchange_failed"` and SHALL NOT include the response
  body verbatim in the message (it can carry a token).
- WHEN `steamOpenIdLink()`'s `handleCallback` receives a `claimed_id` that does not match
  `^https://steamcommunity\.com/openid/id/[0-9]{17}$`, the system SHALL throw
  `AccountLinkCallbackError` with `reason: "state_invalid"` and SHALL NOT call the Steam Web API.
- WHEN `steamOpenIdLink()`'s `handleCallback` performs the `check_authentication` round trip, the
  system SHALL post it to the HARDCODED constant `https://steamcommunity.com/openid/login` and
  SHALL NOT read the destination from `openid.op_endpoint` (or any other callback-supplied field).
  This is a security criterion, not a tidiness one: the round trip exists to ask Steam whether the
  assertion is genuine, so an attacker who names their own endpoint answers that question
  themselves and every forged assertion self-approves. It defeats the entire verification.
- WHEN `steamOpenIdLink()`'s `handleCallback` receives an `openid.return_to` that does not equal
  the `return_to` the engine presented (byte-exact, including the state query parameter), the
  system SHALL throw `AccountLinkCallbackError` with `reason: "state_invalid"` and SHALL NOT call
  the Steam Web API. OpenID 2.0 has no `state` parameter, so `return_to` is the only channel
  binding this leg has.
- WHEN Steam's `check_authentication` response does not contain `is_valid:true`, the system SHALL
  throw `AccountLinkCallbackError` with `reason: "exchange_failed"`.
- WHEN the Steam callback carries `openid.mode=cancel`, the system SHALL throw
  `AccountLinkCallbackError` with `reason: "denied"`, so PRD 07 reports a player who backed out as
  `account.link_failed{ denied }` and not as `{ state_invalid }`, which reads as an attack.
- WHEN a preset builds a `LinkedIdentity`, the system SHALL set `providerUserId` to the platform's
  IMMUTABLE id (Steam `steamid64`, Twitch numeric user id) and SHALL NOT set it to a vanity/display
  name, which the platform lets the user change.
- WHEN the engine builds a `BeforeLinkContext` for a COLD (anonymous, no-contact-yet) callback, the
  system SHALL set `contactId` to `null` and `anonymousId` to the browser key, and SHALL NOT mint a
  contact in order to populate the field. `beforeLink` is fail-closed and runs before every write
  (DECISIONS §9), so minting first would leave a contact behind every vetoed link.
- WHEN a hook context carries `userId`, the system SHALL set it to the canonical contact key
  `contactKey()` (`external_id ?? anonymous_id ?? id`), the SAME definition PRD 08's outbound
  payloads and PRD 12's SDK types use, so the three planes join on one value.
- WHEN a consumer imports `@hogsend/core`, the system SHALL export every public name in this PRD
  from the package barrel.

## Tasks

### T1 — The contract module
_Boundary:_ `packages/core`
_Depends:_ —

Create `packages/core/src/providers/account-link.ts`, mirroring the layout of
`packages/core/src/providers/sms.ts` (section banners, doc comments that state WHY, identity
factory last).

```ts
/**
 * The identity a provider proves. `providerUserId` is the platform's IMMUTABLE
 * id: Steam `steamid64`, Twitch numeric user id. It is
 * NEVER a vanity name, handle, display name or `#discriminator`: those are
 * user-editable, so keying a link on one lets a player rename themselves onto
 * another player's link row. `username` below is the place for the mutable
 * label, and it is DISPLAY DATA ONLY.
 */
export interface LinkedIdentity {
  providerUserId: string;
  /** Mutable display handle. Never a key. */
  username?: string;
  /**
   * Only set when the platform MARKS the address verified (DECISIONS §6.4).
   * An unverified provider email is a property, not an identity key, and
   * folding it in is the grafting vector `plugin-discord/src/connector.ts:463`
   * exists to close.
   */
  verifiedEmail?: string;
  avatarUrl?: string;
  /** Present only when the provider declares `capabilities.tokens`. */
  tokens?: LinkTokens;
  /** Scalars only — these land on `contacts.properties` (DECISIONS §10). */
  properties?: Record<string, string | number | boolean | null>;
}

export interface LinkTokens {
  accessToken: string;
  refreshToken?: string;
  /** ISO 8601 with offset. */
  expiresAt?: string;
  scopes?: string[];
}

export interface AccountLinkMeta {
  id: string;
  name: string;
  description?: string;
}

export interface AccountLinkCapabilities {
  /** The provider yields OAuth tokens worth sealing. Steam: false/absent. */
  tokens?: boolean;
  /** PKCE on the authorize + exchange legs. */
  pkce?: boolean;
}

export interface AuthorizeUrlArgs {
  /** The signed state token minted by the engine (PRD 07). Opaque here. */
  state: string;
  /** Byte-exact redirect the exchange must repeat. */
  redirectUri: string;
  /** Present iff `capabilities.pkce`. */
  codeChallenge?: string;
}

export interface HandleCallbackArgs {
  /** Raw callback query params, already string-valued. */
  query: Record<string, string>;
  redirectUri: string;
  codeVerifier?: string;
  /** Injected for testability; defaults to `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

export interface AccountSyncArgs {
  providerUserId: string;
  tokens?: LinkTokens;
  fetchImpl?: typeof fetch;
}

export interface AccountLinkProvider {
  readonly meta: AccountLinkMeta;
  readonly capabilities?: AccountLinkCapabilities;
  /** Default `true`. `false` = one live link per contact for this provider. */
  readonly multiple?: boolean;
  /** Only legal when `multiple === false`. Default `"replace"`. */
  readonly onConflict?: "replace" | "reject";
  authorizeUrl(args: AuthorizeUrlArgs): string | Promise<string>;
  handleCallback(args: HandleCallbackArgs): Promise<LinkedIdentity>;
  refresh?(tokens: LinkTokens, fetchImpl?: typeof fetch): Promise<LinkTokens>;
  revoke?(tokens: LinkTokens, fetchImpl?: typeof fetch): Promise<void>;
  /**
   * Opt-in periodic property refresh (DECISIONS §10).
   *
   * Named `sync`, NOT `enrichment`. `enrichment` is a saturated term in this
   * repo: there is a whole unrelated subsystem meaning "buy B2B firmographic
   * data from a vendor" (`EnrichmentProvider`,
   * `engine/src/lib/enrichment-provider-registry.ts`, `enrichment-ledger.ts`,
   * `refineContact()`, the `ENRICHMENT_*` env vars, and a top-level
   * `createHogsendClient({ enrichment })` option at `engine/src/container.ts:483`).
   * This field means "re-read a platform's own API for an account we already
   * own". Different thing, same word: the same collision test that killed
   * `defineLinkProvider` in DECISIONS §2.
   */
  readonly sync?: {
    /**
     * MINIMUM AGE before a row is re-read, as a Duration from `@hogsend/core`
     * (`hours(24)`), NOT a cron string. There is ONE Hatchet cron for every
     * provider (PRD 14) and it ticks on its own cadence, so this value is read
     * PER ROW in the scan predicate `WHERE synced_at < now() - :every`. A cron
     * STRING would need a cron parser this repo does not have and does not
     * otherwise need, to express what `hours(24)` already says.
     */
    every: DurationObject;
    read(args: AccountSyncArgs): Promise<Record<string, string | number | boolean>>;
  };
}
```

The concrete exported type is `DurationObject` (`packages/core/src/duration.ts:1-5`, re-exported
from the barrel at `packages/core/src/index.ts:39`), built by `days()` / `hours()` / `minutes()` and
converted with `durationToMs()`. Import it rather than redeclaring a shape; the guard below and
PRD 14's predicate both go through `durationToMs`.

Also in this file:

- `export class AccountLinkCallbackError extends Error` carrying
  `readonly reason: "denied" | "exchange_failed" | "state_invalid"`. The union is deliberately the
  same three strings the `account.link_failed` payload uses (DECISIONS §8) minus `"vetoed"`, which
  only the hook path can produce, so PRD 07 maps `err.reason` straight onto the event with no
  translation table.
- `export const RESERVED_ACCOUNT_LINK_IDS = ["me", "import", "link-url", "manage", "callback",
  "start", "email", "sms"] as const` with a comment: the first six would shadow a literal segment
  under `/v1/accounts/*` (DECISIONS §2), and `email`/`sms` are already reserved connector/source
  ids elsewhere in the repo (`CLAUDE.md`, webhook-source and connector sections).
- `export const ACCOUNT_LINK_ID_RE = /^[a-z][a-z0-9_-]{0,31}$/`.
- `export function defineAccountLink(provider: AccountLinkProvider): AccountLinkProvider` — the
  identity factory, with the cheap authoring guards from the acceptance criteria. Model the guard
  posture on `defineConnector`: throw at definition time with a message that names the provider id
  and says what to do instead.

Tests: `packages/core/src/providers/account-link.test.ts` (colocated, matching
`providers/email.test.ts` / `providers/domains.test.ts`), run by `packages/core/vitest.config.ts`.
Cases, one per guard: `rejects a non-conforming id`, `rejects a reserved id`,
`rejects onConflict under multiple:true`, `accepts onConflict under multiple:false`,
`rejects refresh without capabilities.tokens`, `rejects revoke without capabilities.tokens`,
`rejects a non-positive sync.every`, `rejects sync without a read function`,
`returns the provider unchanged when valid`. Each guard
test must fail if the guard line is deleted (a guard without such a test is a vacuous green,
DECISIONS §4).

### T2 — Hooks contract
_Boundary:_ `packages/core`
_Depends:_ T1

Add to `packages/core/src/providers/account-link.ts`:

```ts
export interface BeforeLinkContext {
  provider: string;
  identity: LinkedIdentity;
  /**
   * NULL on the COLD path, where no contact exists yet.
   *
   * This is `string | null`, not `string`, because DECISIONS §9 places
   * `beforeLink` strictly BEFORE any write and the hook is FAIL-CLOSED. On the
   * cold path (`/start?anonymous_id=`) the contact has not been resolved yet, so
   * a required `string` could only be satisfied by minting the contact before
   * the veto — which leaves a ghost contact behind every rejected link and puts
   * a write in front of a security hook — or by passing a placeholder, which
   * lies to that hook. Both are worse than a nullable field. A hook that wants
   * to refuse anonymous links refuses on `contactId === null`.
   */
  contactId: string | null;
  /**
   * The browser anonymous key the cold path is binding to. Set iff
   * `contactId === null`. Exactly one of the two is present.
   */
  anonymousId?: string;
  /**
   * The canonical contact key `contactKey()` resolved for `contactId`
   * (`external_id ?? anonymous_id ?? id`, `engine/src/lib/contacts.ts:863-865`).
   * Null on the cold path. This is the SAME definition the outbound payloads and
   * the SDK use for `userId` (DECISIONS §8, PRD 08) — never raw `externalId`, so
   * a consumer can join the PULL, PUSH and IN-PROCESS planes on it.
   */
  userId: string | null;
  /** The contact's own email, null when it has none. Never the provider's. */
  email: string | null;
  /** Set when a DIFFERENT contact currently owns this platform account. */
  currentOwnerContactId?: string;
}

export interface AfterLinkContext extends BeforeLinkContext {
  /** Post-commit, so the contact is always resolved by now. */
  contactId: string;
  method: "oauth" | "import";
  relink: boolean;
  /**
   * The `linked_accounts.version` bigint, as a STRING (DECISIONS §5.1). It
   * exceeds Number.MAX_SAFE_INTEGER, so it is NEVER a JS `number` and never
   * arrives via `parseInt`. A hook comparing versions compares them as
   * `BigInt(a) > BigInt(b)`, not numerically.
   */
  version: string;
  at: string;
}

export interface AfterUnlinkContext {
  provider: string;
  providerUserId: string;
  contactId: string;
  /** `contactKey()`, same definition as {@link BeforeLinkContext.userId}. */
  userId: string | null;
  /** The contact's own email, null when it has none. */
  email: string | null;
  reason: "player" | "api" | "relinked";
  /** Bigint version as a STRING, exactly as on {@link AfterLinkContext}. */
  version: string;
  at: string;
}

/**
 * POSTURES (DECISIONS §9) — these are contract, not implementation detail:
 *  - `beforeLink` is BLOCKING, bounded {@link ACCOUNT_LINK_HOOK_TIMEOUT_MS},
 *    and FAIL-CLOSED. A throw, a timeout, or `{ allow: false }` rejects the
 *    link. A veto hook that fails open is not a veto hook.
 *  - `afterLink` / `afterUnlink` run POST-COMMIT, are AT-LEAST-ONCE (so they
 *    must be idempotent), are FAIL-OPEN, and are bounded by the same 5s. The
 *    success page renders anyway on timeout. Posture precedent: cold-connect's
 *    `afterBind` at `packages/engine/src/cold-connect/index.ts:222-233`.
 * These are IN-PROCESS hooks, not a delivery mechanism (DECISIONS §3.2). A
 * throw does not retry. Use the outbound webhooks for delivery.
 */
export interface AccountLinkHooks {
  beforeLink?(ctx: BeforeLinkContext): Promise<{ allow: boolean; reason?: string } | void>
    | { allow: boolean; reason?: string } | void;
  afterLink?(ctx: AfterLinkContext): Promise<void> | void;
  afterUnlink?(ctx: AfterUnlinkContext): Promise<void> | void;
}

export const ACCOUNT_LINK_HOOK_TIMEOUT_MS = 5_000;
```

The timeout constant lives here, in the zero-dependency package, so the engine (PRD 03/07) and
the docs (PRD 16) quote ONE number.

`userId` and `email` on these contexts are NOT looked up by the hook runner. PRD 03's store reads
them via a join to `contacts` inside the same advisory-locked transaction and returns them as
`owner: { contactId, userId, email }`; PRD 07 and PRD 08 use the same `owner` block for the veto
context and the outbound payloads. Nobody re-reads the database at hook or emit time.

Tests: extend `account-link.test.ts` with type-level compile assertions only (no runtime behaviour
lives here). The runtime posture is tested in PRD 03 and PRD 07.

### T3 — `oauth2Link()` preset factory
_Boundary:_ `packages/core`
_Depends:_ T1

Create `packages/core/src/providers/account-link-presets.ts`.

```ts
export interface OAuth2LinkConfig {
  meta: AccountLinkMeta;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  usePkce?: boolean;
  /** Extra static params on the authorize URL (`force_verify=true`, …). */
  authorizeParams?: Record<string, string>;
  userInfo: {
    url: string;
    /**
     * Extra headers sent on the userinfo request, merged UNDER the
     * `Authorization: Bearer` header the preset sets (so a config can never
     * clobber the bearer). Twitch's Helix API returns 401 on any request
     * without `Client-Id`, so without this field the preset cannot express
     * Twitch and PRD 06 would have to fork a bespoke provider for it.
     */
    headers?: Record<string, string>;
    /** Maps the platform's JSON onto a LinkedIdentity. MUST pick the immutable id. */
    map(json: unknown): Omit<LinkedIdentity, "tokens">;
  };
  /** Seal the grant into `linked_accounts.tokens`? Default false. */
  storeTokens?: boolean;
  multiple?: boolean;
  onConflict?: "replace" | "reject";
  revokeEndpoint?: string;
  sync?: AccountLinkProvider["sync"];
}

export function oauth2Link(config: OAuth2LinkConfig): AccountLinkProvider;
```

Behaviour, all pure except the injected `fetchImpl`:

- `authorizeUrl` builds `authorizeEndpoint?response_type=code&client_id=…&redirect_uri=…&scope=…
  &state=…` plus `authorizeParams`, plus `code_challenge` + `code_challenge_method=S256` when
  `usePkce`. `scope` joins on a single space.
- `handleCallback` checks `query.error` FIRST (`access_denied` and any `*_denied` map to
  `reason: "denied"`, everything else to `"exchange_failed"`), then POSTs the exchange
  `application/x-www-form-urlencoded` with `grant_type=authorization_code`, the byte-identical
  `redirect_uri`, and `code_verifier` when PKCE is on. Then GETs `userInfo.url` with
  `Authorization: Bearer <access_token>` plus every entry of `userInfo.headers` (merged so the
  bearer wins on a key collision) and runs `userInfo.map`.
- `refresh` is emitted only when `storeTokens` is true, and posts `grant_type=refresh_token`. A
  `400` whose body names `invalid_grant` throws `AccountLinkCallbackError` with
  `reason: "exchange_failed"` and a boolean `invalidGrant` field on the error, so PRD 14 can do
  the DECISIONS §10 "keep the link, kill the property sync" branch without string-matching.
- `revoke` is emitted only when `revokeEndpoint` is set AND `storeTokens` is true.
- No error message ever interpolates a raw response body (it can contain a token). Include status
  code and endpoint host only.

Tests: `packages/core/src/providers/account-link-presets.test.ts`, pure, with a stub `fetchImpl`
(no network, no DB): `builds an authorize url with pkce`, `omits pkce params when disabled`,
`maps access_denied to denied`, `maps a 500 exchange to exchange_failed`,
`never leaks the response body into the error message`, `sends code_verifier on exchange`,
`refresh flags invalid_grant`, `omits refresh when storeTokens is false`,
`sends userInfo.headers on the userinfo request` (assert the stub fetch saw `Client-Id` alongside
`Authorization`), `userInfo.headers cannot override the Authorization header`.

### T4 — `steamOpenIdLink()` preset factory
_Boundary:_ `packages/core`
_Depends:_ T1

Same file as T3.

```ts
export interface SteamOpenIdLinkConfig {
  meta?: AccountLinkMeta;          // defaults to { id: "steam", name: "Steam" }
  /** Steam Web API key, used for the profile fetch and the property sync. */
  webApiKey?: string;
  /** The `openid.realm` this deployment presents. */
  realm: string;
  multiple?: boolean;
  onConflict?: "replace" | "reject";
}
export function steamOpenIdLink(config: SteamOpenIdLinkConfig): AccountLinkProvider;
```

Steam is OpenID 2.0, not OAuth2 (this is exactly why the primitive is not named
`defineOAuthLink`, DECISIONS §2), so:

- `authorizeUrl` builds `https://steamcommunity.com/openid/login` with `openid.ns`,
  `openid.mode=checkid_setup`, `openid.return_to` (the engine's callback plus the state as a query
  param, since OpenID 2.0 has no `state` parameter — the state rides in `return_to` and the engine
  verifies it), `openid.realm`, and the identifier-select claimed id / identity constants.
- `handleCallback` runs the `check_authentication` round trip: it echoes back every `openid.*`
  param received with `openid.mode` rewritten to `check_authentication`, and requires
  `is_valid:true` in the plain-text response. Never trust the callback params alone.

  **The round trip is POSTed to the hardcoded module constant
  `const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login"`, never to
  `query["openid.op_endpoint"]`.** This is the load-bearing line of the whole preset. The round
  trip exists to ask STEAM whether an assertion it supposedly issued is genuine; if the callback
  gets to name who answers that question, an attacker points `openid.op_endpoint` at a server they
  control, it replies `is_valid:true` to their forged assertion, and they own any `steamid64` they
  care to type. The verification then certifies nothing while looking exactly like it works, which
  is worse than not verifying at all. Do not read `op_endpoint` for any purpose, and do not make
  the endpoint configurable "for tests" (inject `fetchImpl` instead, which is what
  `HandleCallbackArgs.fetchImpl` is for).

  It also requires `query["openid.return_to"]` to equal, byte for byte,
  `HandleCallbackArgs.redirectUri` — which for Steam is the `return_to` the engine presented for
  this attempt, state query parameter included, exactly as `authorizeUrl` built it. No new config
  field is needed; PRD 07 already has to pass the byte-identical redirect for the OAuth2 leg and
  passes the same value here. OpenID 2.0 has no `state` parameter, so `return_to` is the only
  channel binding available, and an assertion minted for some other `return_to` is a cross-flow
  replay. A mismatch throws `state_invalid` before any network call.
- It then applies `parseSteamClaimedId(claimedId)` — exported as its own pure function,
  `^https://steamcommunity\.com/openid/id/([0-9]{17})$`, returning the 17-digit steamid64 or
  `null`. Anchored on both ends deliberately: an unanchored pattern accepts
  `https://evil.example/?x=https://steamcommunity.com/openid/id/7656…`.
- `capabilities.tokens` is deliberately absent: OpenID 2.0 issues no tokens, so nothing is sealed
  (DECISIONS §10).
- `sync` is emitted only when `webApiKey` is supplied, as `{ every: hours(24), read }`, and its
  `read` calls `IPlayerService/GetRecentlyPlayedGames` into `{ steam_playtime_2wk: <minutes> }`
  (namespaced scalars per DECISIONS §10).

Tests, in `account-link-presets.test.ts`: `builds a checkid_setup url with the realm`,
`rejects a claimed_id on another host`, `rejects a claimed_id with a non-17-digit id`,
`rejects an unanchored claimed_id suffix attack`, `throws exchange_failed when is_valid is false`,
`maps openid.mode=cancel to denied`,
`does not call the web api when the claimed_id is malformed` (assert the stub fetch recorded ONE
call, the `check_authentication` one, or zero), `emits no sync block without a web api key`, plus
the two security cases:

- `posts check_authentication to steamcommunity.com even when op_endpoint names another host` —
  hand the callback an `openid.op_endpoint` of `https://evil.example/openid/login`, assert the stub
  `fetchImpl` recorded exactly one request and its URL origin is `https://steamcommunity.com`.
  **Mutation guard:** rewriting the preset to post to `query["openid.op_endpoint"]` must make this
  test fail. Without that guard the test is a vacuous green over the most dangerous line in the
  package.
- `rejects a return_to that does not match the presented one` — assert `reason === "state_invalid"`
  and that the stub `fetchImpl` recorded ZERO calls. **Mutation guard:** deleting the comparison
  must make it fail.

### T5 — Zod schemas + barrel exports
_Boundary:_ `packages/core`
_Depends:_ T1

Create `packages/core/src/schemas/account-link.schema.ts` mirroring
`packages/core/src/schemas/group.schema.ts`:

- `accountLinkProviderIdSchema` = `z.string().regex(ACCOUNT_LINK_ID_RE)`.
- `providerUserIdSchema` = `z.string().min(1).max(255)`.
- `linkedIdentitySchema` — the wire validator PRD 09's import route reuses, with
  `properties` clamped to scalars.
- `linkMethodSchema` = `z.enum(["oauth", "import"])`.
- `unlinkReasonSchema` = `z.enum(["player", "api", "relinked"])`.

Export them from `packages/core/src/schemas/index.ts` and from the named block in
`packages/core/src/index.ts:70-78` (the block that already lists `groupIdentifySchema` and
friends). Add `export * from "./account-link.js"` and
`export * from "./account-link-presets.js"` to `packages/core/src/providers/index.ts` (that file
is a bare `export *` list, so the types reach the barrel through
`packages/core/src/index.ts:57` `export * from "./providers/index.js"`).

Tests: `packages/core/src/schemas/account-link.schema.test.ts` mirroring
`group.schema.test.ts`, plus one barrel test asserting every public name is importable from
`@hogsend/core`.

### T6 — Changeset
_Boundary:_ `.changeset`
_Depends:_ T1-T5

A minor changeset for `@hogsend/core`: new public surface, additive only.

## Seams
None. This PRD is pure types plus pure functions with an injected `fetch`, so nothing here needs a
real Steam or Twitch credential. The credentials seam lands in PRD 06/07.

## Done when
- [ ] `packages/core/src/providers/account-link.ts` and `account-link-presets.ts` exist and every
      name in T1-T5 is importable from `@hogsend/core`.
- [ ] Neither new file imports `@hogsend/db`, `@hogsend/engine`, `node:crypto` for storage, or any
      runtime dependency beyond `zod` in the schema file. Verify with
      `grep -n "^import" packages/core/src/providers/account-link*.ts`.
- [ ] Every authoring guard has a test that fails when the guard line is removed.
- [ ] The periodic-refresh field is spelled `sync` with an `every: Duration` and a `read()`, and
      `grep -rn "enrichment" packages/core/src/providers/account-link*.ts` returns nothing. The
      pre-existing `EnrichmentProvider` subsystem is untouched.
- [ ] `version` is typed `string` on `AfterLinkContext` and `AfterUnlinkContext`.
- [ ] `BeforeLinkContext.contactId` is `string | null` and `anonymousId` sits beside it, so the cold
      path can run the veto with no contact minted.
- [ ] `OAuth2LinkConfig.userInfo.headers` exists and reaches the userinfo request.
- [ ] `grep -n "op_endpoint" packages/core/src/providers/account-link-presets.ts` shows the string
      only inside a comment explaining why it is never read. The `check_authentication` POST target
      is a module constant.
- [ ] `cd packages/core && pnpm test` green.
- [ ] `pnpm lint` green.
- [ ] `pnpm -C $WT/packages/<pkg> exec tsc --noEmit` for every package touched (NOT root `check-types` — vacuous, DECISIONS §4).
- [ ] `pnpm -C $WT exec turbo run test --filter='!@hogsend/api'` (the `exec` is load-bearing — DECISIONS §4).
- [ ] `cd apps/api && pnpm test` green.
- [ ] `pnpm build` green (this changes the engine's transitive public surface).
- [ ] A changeset exists for `@hogsend/core`.
- [ ] One conventional commit, e.g. `feat(core): add defineAccountLink contract and presets`.

## Implementation Notes

Shipped in four commits: `5bdf91d2` (T1 contract), `e1e2a570` (T2 hooks), `e82a9dc7` (T3/T4
presets), `2ab4693a` (T5/T6 exports, schemas, changeset). 229 tests pass across `packages/core`;
`tsc --noEmit` clean in both `packages/core` and `packages/engine`.

Deviations and decisions taken during the build:

- **Presets live in their own module** (`providers/account-link-presets.ts`, 572 lines) rather than
  appended to `account-link.ts`. The contract module stays readable and the presets carry their own
  fixture-driven test file.
- **`userInfo.headers` merge order**: config headers are spread FIRST so the bearer token wins any
  key collision. A misconfigured `Authorization` in `userInfo.headers` cannot override the real one.
- **Schema/type drift is prevented by bidirectional type-equality assertions** rather than deriving
  one from the other, so a divergence fails to compile.
- **Type-level tests use `@ts-expect-error` (5 sites)**, which is self-guarding: widening a type
  (e.g. `version` to `string | number`) makes the expected error disappear and `tsc` then fails on
  the unused directive. This is why T2 needed no runtime guards.

**Gate trap discovered here, applies to every later PRD.** `pnpm check-types` at the repo root
returned FULL TURBO with 53/53 cached on a change that added new files: turbo hashes git-tracked
files, and an uncommitted new file never moves the cache key, so nothing was type-checked. Run
`tsc --noEmit` directly in the affected package instead. Every delivery brief from T2 onward says so.

**Mutation checks performed by the orchestrator, not just claimed by the builder.** Neutering the
`onConflict` guard failed exactly 1 test; neutering the Steam `openid.op_endpoint` check failed
exactly 1 test. Both restored green afterwards.
