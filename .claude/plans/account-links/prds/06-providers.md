# PRD 06 — Concrete providers: Steam + Twitch

## Goal
Ship the two built-in provider definitions inside `@hogsend/engine` as thin CONFIG over the PRD 01
presets: Twitch through `oauth2Link()`, Steam through `steamOpenIdLink()`. Build the deterministic
Fake fetch + fixtures that let PRD 07's whole route flow be tested with zero real credentials, and
own `lib/account-links-from-env.ts` end to end.

## Discord is deliberately NOT here (DECISIONS §12)

First-party providers are Steam and Twitch. Discord account linking already exists and works:
`plugin-discord`'s `member_link` OAuth branch, `discordColdConnect`, and `contacts.discordId`, which
has 84 non-test references and is load-bearing for DM recipient resolution
(`plugin-discord/src/actions/rest.ts:58`), the `discord` resolver kind, `campaigns/cohort-sql.ts`
targeting, `lib/feed.ts` and Studio's contact picker.

Adding a Discord `defineAccountLink` provider would put a SECOND writer on that column, which is
what created the bidirectional-drift and duplicate-contact risks the plan critique surfaced: the
connector writes only `contacts.discordId` and never `linked_accounts`, so every connector link
would be missing from the authoritative PULL plane, and because `IdentityKind` is not widened
(DECISIONS §7) a link living only in `linked_accounts` is invisible to the `discord` resolver kind,
so a later discord-keyed resolve mints a second contact for the same human. The cleanest fix to two
writers is one writer.

So: **do not add a discord account-link provider, do not dual-write `contacts.discordId`, and do not
write a discordId backfill.** The DECISIONS §7 mirror requirement is withdrawn. Migrating Discord
onto `defineAccountLink` is real work with a backfill and a dual-write window and gets its own stack
later. Steam and Twitch have no pre-existing surface, so they are clean, and they are what the
game-publisher pitch actually needs.

## Locked decisions specific to this PRD
- DECISIONS §3.1: these are NOT plugin packages. They live at
  `packages/engine/src/account-links/{steam,twitch}.ts`. Zero new dependencies, `fetch` only.
- DECISIONS §2: the primitive is `defineAccountLink()` and the protocol is never in the name, which
  is exactly why Steam here is OpenID 2.0 while the other two are OAuth2.
- DECISIONS §6.4: only fold in a provider email the provider marks VERIFIED. PRD 01's
  `LinkedIdentity` encodes this structurally: the only email field is `verifiedEmail?`, so an
  unverified address has nowhere to go except `properties`.
- DECISIONS §6.3: a provider definition never resolves a contact. It returns a `LinkedIdentity` and
  PRD 07 binds it to the contact sealed in the state token.
- DECISIONS §10: tokens are sealed only for providers declaring token use. Steam stores nothing,
  because OpenID 2.0 issues nothing (`capabilities.tokens` deliberately absent, PRD 01 T4).
- DECISIONS §10: the periodic property refresh field is spelled **`sync: { every: Duration, read() }`**,
  never `enrichment`. `enrichment` already means "buy B2B firmographic data from a vendor" in this
  repo (`EnrichmentProvider`, `enrichment-provider-registry.ts`, `refineContact()`, the
  `createHogsendClient({ enrichment })` option at `container.ts:483`), and this field means "re-read
  a platform's own API for an account we already own". `every` is a `Duration` (`hours(24)`)
  expressing the MINIMUM AGE before a re-read, which the ONE cron in PRD 14 reads per row. Do not
  rename or touch the pre-existing enrichment subsystem.
- BACKLOG note: real credentials are the known seam. Build to the Fakes, mark `[~]`, keep going.

## What is already PRD 01's job, and must not be rebuilt here

PRD 01 T3/T4 own all the protocol mechanics: authorize-URL construction, the PKCE challenge, the
form-encoded token exchange, the `error=access_denied` mapping, `AccountLinkCallbackError`, the
`refresh` / `invalid_grant` flag, `userInfo.headers`, the Steam `check_authentication` round-trip
posted to Steam's HARDCODED endpoint, the `return_to` echo check, the `openid.mode=cancel` mapping,
`parseSteamClaimedId` and the Steam property-sync reader. This PRD supplies **configuration** and
engine-level test infrastructure. If a task here starts re-implementing an exchange or a security
assertion, it is in the wrong package.

## Provider matrix

| | steam | twitch |
| --- | --- | --- |
| Preset | `steamOpenIdLink()` | `oauth2Link()` |
| Protocol | OpenID 2.0 `checkid_setup` | OAuth2 code + PKCE |
| `scopes` | not applicable | `["user:read:email"]` |
| `usePkce` | not applicable | `true` |
| `storeTokens` | not applicable | `true` |
| `capabilities.tokens` | absent | `true` |
| Email available | never | yes, no verified flag |
| Sets `verifiedEmail` | never | **never** |
| Config | `realm` (required), `STEAM_WEB_API_KEY` (OPTIONAL) | `ACCOUNT_LINK_TWITCH_CLIENT_ID` / `_CLIENT_SECRET` |
| `refresh` / `revoke` | neither | both (`revokeEndpoint` set) |
| `sync` | `{ every: hours(24), read }` yielding `steam_playtime_2wk` (PRD 01 T4, needs the web api key) | deferred to PRD 14 |

**Twitch email is a property, never an identity key.** Twitch's Helix `GET /helix/users` returns an
`email` field when the token carries `user:read:email`, but Twitch exposes no per-address
verification boolean. DECISIONS §6.4 makes an unverified provider email a property, so the Twitch
`userInfo.map` leaves `verifiedEmail` unset and puts the address in `properties.twitch_email` (a
scalar, per `LinkedIdentity.properties`). Neither v1 provider ever sets `verifiedEmail`: Steam yields
no email at all, and Twitch's is unverifiable. That is not a gap — DECISIONS §6.4 says a
provider-reported email is never a merge key regardless, so the field simply has no v1 producer, and
the email folds in later through a path we do trust (DECISIONS §16).

## Acceptance criteria (EARS)

### Shared
- WHEN a provider definition is constructed, the system SHALL pass through `defineAccountLink()` so
  the PRD 01 authoring guards run, and SHALL expose `meta.id` of exactly `"steam"` or `"twitch"`
  with a `meta.name` fit for the embed SDK's button label.
- WHEN this PRD ships, `packages/engine/src/account-links/` SHALL contain no discord provider, and
  `grep -rn "discordId" packages/engine/src/account-links packages/engine/src/lib/account-links*.ts`
  SHALL return nothing. `plugin-discord` is untouched.
- WHEN `handleCallback` is called with a `fetchImpl`, the system SHALL make every outbound HTTP call
  through it and SHALL make none through the global `fetch`.
- WHEN any provider call fails with a non-2xx, the thrown `AccountLinkCallbackError` message SHALL
  carry the status and endpoint host only, never the response body, the client secret, or token
  material. Precedent verbatim: `packages/plugin-discord/src/connect/oauth.ts:98-107` and `:144-148`.
- WHEN a `userInfo.map` runs, the system SHALL set `providerUserId` to the platform's IMMUTABLE id
  and SHALL NOT set it to a vanity or display name.

### Twitch
- WHEN `authorizeUrl()` is called, the resulting URL SHALL be
  `https://id.twitch.tv/oauth2/authorize` carrying `response_type=code`, `client_id`,
  `redirect_uri`, `scope=user:read:email`, `state`, `code_challenge`, `code_challenge_method=S256`
  and `force_verify=true`.
- WHEN the profile is fetched, the request SHALL carry BOTH `Authorization: Bearer <token>` and
  `Client-Id: <ACCOUNT_LINK_TWITCH_CLIENT_ID>`.
- WHEN the Helix response has an empty `data` array, the system SHALL throw rather than return an
  identity with an empty `providerUserId`.
- WHEN a Twitch email is present, the system SHALL NEVER set `verifiedEmail`, and SHALL place the
  address in `properties.twitch_email`.

### Steam
- WHEN `authorizeUrl()` is called, the resulting URL SHALL be
  `https://steamcommunity.com/openid/login` with `openid.mode=checkid_setup`, the identifier-select
  constants, `openid.realm` equal to the configured realm, and `openid.return_to` equal to the
  callback URI with the state appended as a query param (OpenID 2.0 has no `state` parameter).
- WHEN the callback arrives, the system SHALL complete the `check_authentication` round-trip against
  Steam's HARDCODED endpoint and SHALL treat the link as proven only on `is_valid:true`. **A Steam
  link that skips this round-trip is forgeable: the `openid.*` query string is entirely
  attacker-authored. A Steam link that posts the round-trip to a callback-supplied
  `openid.op_endpoint` is equally forgeable, because the attacker then answers their own
  verification.** PRD 01 T4 owns both, with the mutation-guarded tests.
- WHEN the echoed `openid.return_to` does not equal the `return_to` this flow was minted against, the
  system SHALL throw `state_invalid` BEFORE any network call. PRD 01 T4 owns it.
- WHEN `openid.mode` is `cancel`, the system SHALL throw `AccountLinkCallbackError` with
  `reason: "denied"`, so PRD 07 maps it to `account.link_failed{denied}` rather than
  `{state_invalid}`. PRD 01 T4 owns it.
- WHEN the identity is proven, the returned `LinkedIdentity` SHALL have no `verifiedEmail` and no
  `tokens`, ALWAYS.
- WHEN the best-effort `GetPlayerSummaries` profile pull fails or times out, the system SHALL still
  return the proven identity with `username` unset. A cosmetic pull must never fail a proven link.

## Tasks

### T1 — Deterministic Fakes + fixtures
_Boundary:_ `packages/engine`
_Depends:_ 01

New files under `packages/engine/src/account-links/__fixtures__/`:

- `twitch.json`: a Helix `{ data: [ … ] }` body, plus an empty-`data` variant.
- `steam.json`: an `is_valid:true` plain-text body, an `is_valid:false` body, and a
  `GetPlayerSummaries` body.
- `fake-fetch.ts`:
  ```ts
  export function fakeFetch(routes: Record<string, { status?: number; body?: unknown; text?: string }>): {
    fetchImpl: typeof fetch;
    calls: { url: string; method: string; headers: Record<string, string>; body: string | null }[];
  };
  ```
  Routes key on `method + " " + url-without-query`, so a test asserts query params off `calls`
  rather than baking them into the key. An unmatched call THROWS with the URL, so a provider that
  quietly reaches a fourth endpoint fails loudly instead of hanging on a real network call.

This is the pattern `plugin-apollo` already proved: an injectable `fetch`
(`packages/plugin-apollo/src/index.ts:46-47`, "the whole suite runs offline through this") resolved
as `config.fetch ?? fetch` (`:140`). Here the injection point is PRD 01's
`HandleCallbackArgs.fetchImpl`, so the engine providers need no `fetch` field of their own and PRD
07's route tests thread the same `fetchImpl` in.

Tests `packages/engine/src/account-links/__fixtures__/fake-fetch.test.ts`:
- `records calls with method, headers and body`
- `throws on an unmatched route`
- `serves a text body for the steam check_authentication route`

### T2 — Twitch provider
_Boundary:_ `packages/engine`
_Depends:_ T1, 01

New file `packages/engine/src/account-links/twitch.ts`:

```ts
export interface TwitchAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}
export function twitchAccountLink(config: TwitchAccountLinkConfig): AccountLinkProvider;
```

Body is one `oauth2Link({ … })` call with:

```ts
authorizeEndpoint: "https://id.twitch.tv/oauth2/authorize",
tokenEndpoint:     "https://id.twitch.tv/oauth2/token",
scopes: ["user:read:email"],
usePkce: true,
storeTokens: true,
authorizeParams: { force_verify: "true" },
revokeEndpoint: "https://id.twitch.tv/oauth2/revoke",
userInfo: { url: "https://api.twitch.tv/helix/users", headers: { "Client-Id": config.clientId }, map: mapTwitchUser },
```

`mapTwitchUser` is exported for direct unit testing and is the only real logic in the file.

`userInfo.headers` is part of `OAuth2LinkConfig` as of PRD 01 T3, and the preset merges it under the
`Authorization: Bearer` header. Helix returns 401 on any request without `Client-Id`, which is why
that field exists. Do not re-implement the profile fetch in the engine to work around it.

Tests `packages/engine/src/account-links/twitch.test.ts`:
- `authorizeUrl carries scope=user:read:email and force_verify`
- `the Helix profile call sends both Authorization and Client-Id` (the single most common Twitch
  integration mistake, so it gets its own named test)
- `mapTwitchUser maps data[0] to a LinkedIdentity`
- `mapTwitchUser never sets verifiedEmail and stores twitch_email instead`
- `mapTwitchUser throws when data is empty`
- `the full handleCallback runs through the injected fetchImpl with no network`
- `a 401 from /helix/users throws exchange_failed with no response body in the message`

### T3 — Steam provider
_Boundary:_ `packages/engine`
_Depends:_ T1, 01

New file `packages/engine/src/account-links/steam.ts`:

```ts
export interface SteamAccountLinkConfig {
  webApiKey: string;
  /** openid.realm this deployment presents. API_PUBLIC_URL, trailing slash stripped. */
  realm: string;
}
export function steamAccountLink(config: SteamAccountLinkConfig): AccountLinkProvider;
```

Body is one `steamOpenIdLink({ meta, webApiKey, realm })` call. Everything else, the
`checkid_setup` URL, the `check_authentication` round-trip, `parseSteamClaimedId`, the
`steam_playtime_2wk` sync reader, is PRD 01 T4.

Docstring must state the three things a reader will come looking for: there is no `code`, no PKCE and
no token in OpenID 2.0, so PRD 07 skips its PKCE mint for this provider and PRD 03 writes a null
`linked_accounts.tokens`.

Tests `packages/engine/src/account-links/steam.test.ts` (engine-level, driving the Fake, distinct
from PRD 01's pure preset tests):
- `authorizeUrl carries identifier_select, the configured realm and a return_to containing the state`
- `a proven callback yields a 17-digit providerUserId, no verifiedEmail and no tokens`
- `a failing GetPlayerSummaries still yields a proven identity with no username`
- `sync is present because a web api key is configured, and its every is hours(24)`
- `the security assertions hold end to end` — one engine-level case per PRD 01 T4 guard (foreign
  `op_endpoint`, mismatched `return_to`, `mode=cancel`), driven through this provider and the Fake,
  proving the configured provider actually inherits them rather than only the bare preset doing so.

### T4 — Barrel, `accountLinksFromEnv`, and the container merge
_Boundary:_ `packages/engine`
_Depends:_ T2, T3, PRD 05

**This task is the SOLE owner of `packages/engine/src/lib/account-links-from-env.ts`.** PRD 05
deliberately does not create it: the file statically imports `../account-links/steam.js` and
`../account-links/twitch.js`, which do not exist until T2/T3, so a PRD 05 that owned it could not
pass `pnpm check-types`. See PRD 05's "The 05/06 boundary" table.

Three pieces:

**(a) `packages/engine/src/account-links/index.ts`** exports `steamAccountLink` and
`twitchAccountLink`, and `packages/engine/src/index.ts` re-exports both, so a consumer can construct
one directly with code-supplied config.

**(b) `packages/engine/src/lib/account-links-from-env.ts`:**

```ts
export interface AccountLinkEnvResult {
  providers: AccountLinkProvider[];
  /** One line per partially-configured provider. The container logs each ONCE. */
  warnings: string[];
}
export function accountLinksFromEnv(env: EngineEnv): AccountLinkEnvResult;
```

Structural mirror of `lib/email-providers-from-env.ts:89-165`, with two divergences to call out in
the docstring:

1. **Static imports.** No `loadOptionalPlugin`, no runtime-assembled specifier, because these are
   in-package (DECISIONS §3.1). No top-level `await`, so `createHogsendClient` stays synchronous.
2. **It returns warnings rather than calling `console.warn`.** The email preset builder warns
   straight to `console.warn` (`email-providers-from-env.ts:143`) because it runs before a logger
   exists. Here the container already has `logger`, so the strings come back and the container logs
   them through the real logger. That keeps this function pure and unit-testable with no console spy.

Rules:
- twitch registered iff BOTH `ACCOUNT_LINK_TWITCH_CLIENT_ID` and `_CLIENT_SECRET` are set. Exactly
  one set ⇒ no registration + a warning naming the MISSING var.
- **steam is registered UNCONDITIONALLY.** "Sign in through Steam" is OpenID 2.0: the RP presents no
  credential of any kind. There is no app to register, no client id, no secret; the whole security
  model is the server-side `check_authentication` round-trip, which is unauthenticated by design.
  Gating registration on `STEAM_WEB_API_KEY` would make a zero-config deploy silently lack the single
  most valuable provider for the target ICP, and would gate LOGIN behind a key login does not use.
  The only genuine requirement is the `realm`, and that is derived from `API_PUBLIC_URL`, which the
  engine env already requires. Steam therefore contributes no warning and cannot be half-configured.
- `STEAM_WEB_API_KEY` is OPTIONAL and widens the provider rather than enabling it. Absent: linking
  works, `providerUserId` is the 17-digit steamid, and the identity carries no persona name or avatar
  (`account-link-presets.ts:405` already returns `{}` from the profile pull without a key, and the
  `sync` capability is conditionally attached at `:535`). Present: `GetPlayerSummaries` fills the
  display properties and the PRD 14 playtime sync attaches. Do not re-derive this in the env builder
  — pass `webApiKey: env.STEAM_WEB_API_KEY` straight through and let the preset branch.
- `steamOpenIdLink()` requires a `realm` (PRD 01 T4), which is
  `env.API_PUBLIC_URL` with any trailing slash stripped, the same normalization the SMS webhook route
  applies at `routes/webhooks/sms-provider.ts:39`. A wrong realm makes Steam reject the assertion, so
  it gets its own assertion in the tests rather than being assumed.
- No discord branch. Do not add one.

**(c) The container merge**, one line at the build site PRD 05 left a comment on
(`container.ts`, next to the SMS registry block):

```ts
const accountLinkEnv = accountLinksFromEnv(env);
for (const w of accountLinkEnv.warnings) logger.warn(w);
const accountLinkProviders = new AccountLinkProviderRegistry([
  ...accountLinkEnv.providers,
  ...(opts.accountLinks?.providers ?? []),
]);
```

Env presets first, consumer last, identical to the email merge at `container.ts:1012-1016` and for
the reason spelled out at `:1005-1011`.

Tests `packages/engine/src/lib/account-links-from-env.test.ts`:
- `builds steam and ONLY steam from an otherwise empty env` (the zero-config proof: `ids()` is
  exactly `["steam"]` when no `ACCOUNT_LINK_*` and no `STEAM_WEB_API_KEY` are set)
- `builds twitch when both vars are set`
- `omits twitch and warns naming ACCOUNT_LINK_TWITCH_CLIENT_SECRET when only the id is set`
- `omits twitch and warns naming ACCOUNT_LINK_TWITCH_CLIENT_ID when only the secret is set`
- `registers steam with no web api key and omits the sync capability` (assert the provider EXISTS and
  that `sync` is undefined — the widen-not-enable proof)
- `attaches the steam sync capability when STEAM_WEB_API_KEY is set`
- `passes API_PUBLIC_URL, trailing slash stripped, as the Steam realm`
- `builds no discord provider under any env` (assert `ids()` never contains `"discord"`)
- MUTATION GUARD (DECISIONS §4): `omits twitch … when only the id is set` must fail if the `&&` in
  the twitch gate is relaxed to `||`.

Plus, in `packages/engine/src/container.account-links.test.ts` (the file PRD 05 created), the
env-preset cases PRD 05 deferred here:
- `registers twitch + steam from env`
- `a consumer provider of the same id overrides the env preset`
- `warns once, does not throw, on a half-configured twitch`

Changeset: `@hogsend/engine` minor.

## Seams

Real credentials, exactly as the BACKLOG note states. The human ask, verbatim:

1. **Steam**: NOT a seam. Login needs no credential and works on a bare deploy. A Steam Web API key
   from `https://steamcommunity.com/dev/apikey` is OPTIONAL and only adds persona name + avatar and
   the PRD 14 playtime sync. Set `STEAM_WEB_API_KEY` when you want those.
2. **Twitch**: an application at `https://dev.twitch.tv/console/apps` with OAuth redirect URL
   `<API_PUBLIC_URL>/v1/accounts/twitch/callback`. Set `ACCOUNT_LINK_TWITCH_CLIENT_ID` and
   `ACCOUNT_LINK_TWITCH_CLIENT_SECRET`.

Every task above is fully green without any of them, through the T1 Fakes. Mark this PRD `[~]` if the
credentials have not landed, and let PRD 07 proceed.

## Done when
- [ ] Two provider files plus the fixtures and `fake-fetch.ts` exist, and each provider file is
      configuration over a PRD 01 preset with no re-implemented exchange.
- [ ] Twitch's Helix call sends `Client-Id`, asserted by a named test.
- [ ] Neither provider ever sets `verifiedEmail`.
- [ ] Steam's PRD 01 security assertions hold through the configured provider (foreign
      `op_endpoint`, mismatched `return_to`, `mode=cancel`).
- [ ] `lib/account-links-from-env.ts` exists here and only here, and the container merges its
      providers ahead of the consumer list.
- [ ] No discord provider exists:
      `grep -rn "discord" packages/engine/src/account-links packages/engine/src/lib/account-links-from-env.ts`
      returns nothing, and `plugin-discord` is unmodified (`git diff --stat` shows no file under
      `packages/plugin-discord/`).
- [ ] No test performs real network I/O and no error message contains a response body or a secret.
- [ ] Changeset added for `@hogsend/engine`.
- [ ] `pnpm lint`
- [ ] `pnpm -C $WT/packages/<pkg> exec tsc --noEmit` for every package touched (NOT root `check-types` — vacuous, DECISIONS §4).
- [ ] `pnpm -C $WT exec turbo run test --filter='!@hogsend/api'` (the `exec` is load-bearing — DECISIONS §4).
- [ ] `cd apps/api && pnpm test`
- [ ] `pnpm build`
- [ ] `pnpm --filter @hogsend/engine test`

## Implementation Notes

### Verification

All five gates green: lint, engine `tsc --noEmit`, full `apps/api` (2527 passed; only the known
pre-existing `health-activity` failure), `turbo run test --filter='!@hogsend/api' --force
--concurrency=2` (46/46, 0 cached), `turbo run build --force` (29/29).

Mutation guards, each restored and re-verified:
- **Steam unconditional** — gating the steam push on `STEAM_WEB_API_KEY` fails
  `builds steam and ONLY steam from an otherwise empty env`.
- **The hardcoded `check_authentication` endpoint** — the single most important guard in the
  feature. Removing the `op_endpoint` equality check AND pointing the verification POST at
  `opEndpoint ?? STEAM_OPENID_ENDPOINT` (the forgeable shape) fails
  `the security assertions hold end to end`, verified independently through the CONFIGURED provider,
  not just the preset. `packages/core` confirmed byte-clean afterwards.
- **`verifiedEmail`** — adding `verifiedEmail: user.email` to `mapTwitchUser` fails
  `mapTwitchUser never sets verifiedEmail and stores twitch_email instead`.
- **The twitch `&&`** — relaxing it to `||` fails the half-configured cases both ways.
- **No Discord** — pushing a fake discord provider fails `builds no discord provider under any env`;
  `plugin-discord` diff is empty.

No test performs network I/O: the fake fetch throws on any unmatched route, and every refusal path
asserts `calls.length === 0` before the network.

### Two consequences of unconditional Steam — RAISED, not silently accepted

Registering Steam without a credential is correct (OpenID 2.0 presents none), but it collides with
this repo's standing inert-when-unconfigured posture, in two places:

1. PRD 05's boot warning "providers are registered but no allowed origin is configured" now fires on
   EVERY deploy, because `count() > 0` is always true. Pinned by a test so it is a visible decision
   rather than drift.
2. Once PRD 07 lands, EVERY Hogsend deploy exposes a live, publicly-callable
   `/v1/accounts/steam/*` regardless of operator intent.

(2) is the substantive one: it widens the public surface of every existing deployment, including
those that will never use account links, and the cold-start path mints contacts. That trades the
zero-config win against the house posture, and the resolution is a product call — see the decision
recorded at the top of PRD 07.
