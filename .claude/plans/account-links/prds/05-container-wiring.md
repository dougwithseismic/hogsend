# PRD 05 — Container wiring + provider registry

## Goal
Give `createHogsendClient` an `accountLinks: { providers, hooks, allowedOrigins }` option, build an
`AccountLinkProviderRegistry` keyed by `meta.id`, and expose `client.accountLinkProviders`,
`client.accountLinkHooks` and `client.accountLinkAllowedOrigins`. Declare the env vars the built-in
providers will read, and surface every misconfiguration ONCE at boot rather than in a player's face
at link time.

## The 05/06 boundary (settled — do not blur it again)

This PRD owns the REGISTRY and the CONTAINER. **PRD 06 owns the concrete providers AND
`packages/engine/src/lib/account-links-from-env.ts`, including the one-line container edit that
merges the env presets in.** An earlier draft had PRD 05 create that file with a static
`import … from "../account-links/steam.js"`, which does not exist until PRD 06 builds it: PRD 05
would then fail `pnpm check-types`, and a delivery agent forbidden from editing plan docs would stub
the provider files inside its own boundary for PRD 06 to duplicate or delete.

The split is forward-only, so BACKLOG order (05 then 06) holds:

| File | Owner |
| --- | --- |
| `lib/account-link-provider-registry.ts` | 05 |
| `lib/account-link-origins.ts` (`parseAllowedOrigins`) | 05 |
| `env.ts` var declarations | 05 |
| `container.ts` option group, client fields, registry build from `opts.accountLinks.providers` | 05 |
| `account-links/steam.ts`, `account-links/twitch.ts`, the Fakes, `account-links/index.ts` | 06 |
| `lib/account-links-from-env.ts` | 06 |
| the `container.ts` line that merges `accountLinksFromEnv(env).providers` in front of the consumer list | 06 |

PRD 05 therefore registers ONLY consumer-supplied providers. That is not a gap: with no built-ins
built yet there is nothing else to register, and the merge order (env presets first, consumer last)
is preserved because PRD 06 prepends.

## Locked decisions specific to this PRD
- DECISIONS §12: first-party providers are **Steam and Twitch**. Discord is out of v1 and gets no
  env vars, no preset and no registry entry here. It already links through `plugin-discord`.
- DECISIONS §3.1: providers are **not** plugin packages. The built-ins live in `@hogsend/engine`, so
  there is NO `loadOptionalPlugin` dance. Contrast `email-providers-from-env.ts:33-47` (Postmark)
  and `:68-79` (Hogsend Email), which need the runtime-assembled specifier ONLY because those
  packages are `optionalDependencies`. An account link provider is a URL, one `fetch` and a field
  mapping, so it is statically imported (by PRD 06).
- DECISIONS §3.1: the set stays open. A third party authors with `defineAccountLink()` in their own
  repo and passes it through `accountLinks.providers`.
- DECISIONS §6.6: `postMessage` targets a configured origin allowlist, never `*`. The allowlist is
  an env var declared here (PRD 07 enforces it on `returnTo`, PRD 10 on `postMessage`).
- DECISIONS §9: `AccountLinkHooks` is `{ beforeLink?, afterLink?, afterUnlink? }`, in-process only,
  and it is defined in `@hogsend/core` by PRD 01 T2 along with `ACCOUNT_LINK_HOOK_TIMEOUT_MS`. The
  container holds them verbatim. **`beforeLink` is invoked by PRD 07's callback and nothing else;
  `afterLink` / `afterUnlink` are invoked by PRD 03's store and nothing else** (DECISIONS §15.4).
  Callers pass `client.accountLinkHooks` into the store; they never call a hook themselves.
- PRD 01 froze the provider surface: `AccountLinkProvider`, `AccountLinkMeta` (`meta` REQUIRED,
  `ACCOUNT_LINK_ID_RE`, `RESERVED_ACCOUNT_LINK_IDS`), `AccountLinkCapabilities { tokens?, pkce? }`.
  Everything here is written against that surface, not against a guess.
- DECISIONS §4: TDD, changeset, one conventional commit per task.

## Registry membership: unconfigured means ABSENT, not present-but-disabled

**Locked here: a provider whose credentials are missing is NOT registered.**

Defence, and why the alternative loses:

1. It is the pattern already committed to. `emailProvidersFromEnv` builds a preset ONLY when its
   credential is present (`lib/email-providers-from-env.ts:92-99` for Resend, `:106` for Postmark,
   `:141` for Hogsend Email), and `smsProvidersFromEnv` does the same. A fourth registry with the
   opposite rule is a rule nobody remembers.
2. Absence makes the failure structural. `GET /v1/accounts/:provider/start` (PRD 07) does a registry
   lookup and 404s on a miss, exactly as the connector route 404s an unknown connector
   (`routes/connectors/index.ts:93-96`) and the SMS webhook route 404s an unknown provider
   (`routes/webhooks/sms-provider.ts:29-31`). A present-but-disabled row would 302 a player to a
   consent screen built from an empty `client_id`, and the player would meet the failure on
   Steam's or Twitch's error page instead of ours.
3. Absence makes the read plane honest. `GET /v1/accounts/providers` (PRD 09) and the embed SDK
   (PRD 13) enumerate the registry, so a button only renders for a provider that can actually
   complete. A disabled flag means every consumer of the registry has to re-check it, and the one
   call site that forgets is a runtime break.
4. Enabled-ness is not a per-request decision, so it does not need to be a per-request field. The
   credentials are read once at boot and never change without a redeploy.

The cost of absence is silence, and that is what boot validation below buys back.

## Env var convention

Declared in `packages/engine/src/env.ts` inside the `createEnv({ server: { … } })` block, next to the
`TWILIO_*` / `POSTMARK_*` blocks, all `.optional()`:

| Var | Purpose |
| --- | --- |
| `ACCOUNT_LINK_TWITCH_CLIENT_ID` | Twitch app client id (also sent as the `Client-Id` header on Helix, via `userInfo.headers` from PRD 01 T3) |
| `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` | Twitch app client secret |
| `STEAM_WEB_API_KEY` | OPTIONAL. Steam Web API key. Adds the profile pull (persona, avatar) and the PRD 14 playtime sync. It does NOT enable the provider — Steam login is OpenID 2.0 and presents no credential, so the provider registers without it |
| `ACCOUNT_LINK_ALLOWED_ORIGINS` | csv of absolute origins (`https://play.example.com,https://www.example.com`). The ONE allowlist governing both `returnTo` (PRD 07) and `postMessage` `targetOrigin` (PRD 10). Unset ⇒ empty list ⇒ no `returnTo` accepted and `postMessage` is not attempted. A malformed entry THROWS at boot; see T3 |
| `ACCOUNT_LINK_STATE_TTL_SECONDS` | Optional. State/PKCE TTL. `z.coerce.number().int().positive().default(900)`, matching the 900s window the connector nonce burn already assumes (`routes/connectors/index.ts:139`) |

The convention is `ACCOUNT_LINK_<PROVIDER_ID_UPPERCASED>_CLIENT_ID` / `_CLIENT_SECRET`, with
`STEAM_WEB_API_KEY` the one deliberate exception (Steam has no OAuth client pair at all, so a
`_CLIENT_SECRET` name would be a lie, and `STEAM_WEB_API_KEY` is the name every Steam integration in
the world already uses).

This PRD DECLARES these vars; PRD 06 READS them in `accountLinksFromEnv`. Declaring them here keeps
the whole env contract in one commit and lets PRD 06 be purely additive.

**Only the two built-ins get declared vars.** `@t3-oss/env-core` validates a STATIC schema
(`env.ts:21`, `runtimeEnv: process.env`), so a dynamically-named key for a consumer-authored provider
cannot be part of the validated contract. Consumer providers configure in CODE, via the closure they
pass to `accountLinks.providers`. This is the same line already drawn for consumer-supplied email
providers.

## Acceptance criteria (EARS)

- WHEN `createHogsendClient()` is called with no `accountLinks` option and no `ACCOUNT_LINK_*` /
  `STEAM_WEB_API_KEY` env, the system SHALL expose `client.accountLinkProviders.count() === 0` and
  `client.accountLinkHooks` deep-equal to `{}`, and SHALL NOT log a warning.
  **Scope note:** this criterion describes PRD 05 IN ISOLATION, where no env presets exist yet. Once
  PRD 06 lands, the steady state of an empty env is `count() === 1` (steam, which needs no
  credential — see PRD 06's provider matrix). PRD 06 owns updating this assertion; do not write a
  test here that PRD 06 must then delete.
- WHEN a consumer passes a provider through `accountLinks.providers` whose `meta.id` collides with an
  env preset (added by PRD 06), the system SHALL keep the CONSUMER provider (last-writer-wins),
  mirroring `EmailProviderRegistry.register` (`lib/email-provider-registry.ts:30-32`).
- WHEN a consumer passes two providers with the same `meta.id` inside one `providers` array, the
  system SHALL keep the last one and SHALL log one `logger.warn` naming the duplicated id.
- WHEN `accountLinks.hooks` is supplied, the system SHALL expose it verbatim as
  `client.accountLinkHooks` without wrapping or defaulting individual hooks.
- WHEN `ACCOUNT_LINK_ALLOWED_ORIGINS` (or `accountLinks.allowedOrigins`) contains an entry that is
  not a parseable absolute origin — a path, a bare `*`, a wildcard host, or anything whose
  `new URL(entry).origin` does not round-trip to itself — the system SHALL THROW during container
  construction, naming the offending entry.

  Throw, not drop-and-warn. An allowlist entry is a security control, and a silently dropped one
  produces the exact failure PRD 13 calls the most likely first-run misconfiguration: a link button
  that spins until it times out, with the link having committed server-side. The `FX_RATES`
  precedent argues the same way rather than against it, because `FX_RATES` is parsed outside the env
  schema (`env.ts:173-176`, `lib/fx.ts:51-64`) precisely so it can fail LOUD at boot. PRD 10's
  boot-time `resultRedirect` allowlist check also depends on the list being complete: under
  drop-and-warn a typo'd origin silently shrinks the list, so a legitimate `resultRedirect` throws at
  boot for entirely the wrong reason and the operator chases the wrong bug.
- WHEN any provider is registered AND `ACCOUNT_LINK_ALLOWED_ORIGINS` is unset, the system SHALL log
  one `logger.warn` stating that no `returnTo` or `postMessage` origin is permitted, so a silent
  no-redirect flow is diagnosable at boot rather than after a player closes the popup.

## Tasks

### T1 — `AccountLinkProviderRegistry`
_Boundary:_ `packages/engine`
_Depends:_ 01 (`AccountLinkProvider` type)

New file `packages/engine/src/lib/account-link-provider-registry.ts`, a direct structural mirror of
`lib/email-provider-registry.ts`:

```ts
export class AccountLinkProviderRegistry {
  private byId = new Map<string, AccountLinkProvider>();
  constructor(providers?: AccountLinkProvider[]);
  register(provider: AccountLinkProvider): void; // last-writer-wins on meta.id
  get(id: string): AccountLinkProvider | undefined;
  getAll(): AccountLinkProvider[];
  ids(): string[];
  count(): number;
}
```

Divergence from the email registry to state in the class docstring: `meta.id` is REQUIRED here (no
`?? "resend"` back-compat fallback, `email-provider-registry.ts:31`), because this contract is new and
has no pre-`meta` era. `register` throws `TypeError` on a provider with an empty/absent `meta.id`.
It does NOT re-validate `ACCOUNT_LINK_ID_RE` or `RESERVED_ACCOUNT_LINK_IDS`: `defineAccountLink()`
already throws at definition time on both (PRD 01 T1), and a second copy of that rule is a second
place to update.

Deliberately NOT a process singleton, for the same reason spelled out at
`lib/email-provider-registry.ts:10-14`: every reader (the `/v1/accounts/*` routes, PRD 09's data
plane, PRD 14's property-sync cron via the worker container) holds a container reference.

Tests, `packages/engine/src/lib/account-link-provider-registry.test.ts` (`tsx --test`, per
`packages/engine/package.json:34`):
- `register replaces a provider of the same id (last-writer-wins)`
- `get returns undefined for an unknown id`
- `register throws on a provider with no meta.id`
- `getAll preserves insertion order of distinct ids`

### T2 — Env declarations
_Boundary:_ `packages/engine`
_Depends:_ —

Add the six vars from the table above to `packages/engine/src/env.ts`, each with the comment style
already used in that file (why it exists, what its absence means). Place the block after the
`ENRICHMENT_*` block (`env.ts:212-232`) and before the Hatchet block.

`ACCOUNT_LINK_ALLOWED_ORIGINS` is a plain `z.string().optional()` (a csv), NOT a parsed array: the
parse + per-entry validation lives in T3, outside the env schema, so it can throw a message that
names the offending entry rather than a generic Zod failure. This is the `FX_RATES` stance
(`env.ts:173-176`, parsed in `lib/fx.ts:51-64`), which is a fail-LOUD-at-boot precedent, not a
fail-soft one.

Test `packages/engine/src/lib/account-links-env.test.ts`:
- `ACCOUNT_LINK_STATE_TTL_SECONDS defaults to 900`
- `an unset ACCOUNT_LINK_* block leaves env validation green`

### T3 — `parseAllowedOrigins`, fail-loud
_Boundary:_ `packages/engine`
_Depends:_ T2

New file `packages/engine/src/lib/account-link-origins.ts`:

```ts
/**
 * Parse the ONE origin allowlist governing `returnTo` (PRD 07) and the
 * `postMessage` targetOrigin (PRD 10). THROWS on a malformed entry rather than
 * dropping it: an allowlist is a security control, and a silently shortened one
 * produces a link button that spins to a timeout while the link has already
 * committed server-side — the single most likely first-run misconfiguration
 * (PRD 13). Precedent: FX_RATES is parsed outside the env schema for exactly
 * this reason (env.ts:173-176, lib/fx.ts:51-64).
 */
export function parseAllowedOrigins(entries: string | string[] | undefined): string[];
```

Behaviour: accept a csv string (the env var) or an array (the consumer option); trim; drop empty
entries; for each remaining entry require `new URL(entry).origin === entry`, so
`https://x.example.com/path` is rejected as not-an-origin rather than silently truncated, and a bare
`*` or a wildcard host is rejected outright. On any failure throw naming the entry and the source
(env var or option). Return the deduped list, order preserved.

The env and the consumer option are concatenated (env first, consumer last, matching every other
merge in the container) and parsed as ONE list, so the same rule applies to both and PRD 10 has one
validated array to read.

Tests `packages/engine/src/lib/account-link-origins.test.ts`:
- `parses a csv of origins`
- `throws on a path` (`https://x.example.com/cb`)
- `throws on a bare *`
- `throws on a wildcard host` (`https://*.example.com`)
- `throws naming the offending entry`
- `returns an empty array for undefined and for an empty string`
- `dedupes`
- MUTATION GUARD (DECISIONS §4, vacuous-green rule): replacing the throw with a `continue` must make
  the three throw cases fail.

### T4 — Container fields + options
_Boundary:_ `packages/engine`
_Depends:_ T1, T3

In `packages/engine/src/container.ts`:

- `HogsendClientOptions` (from `:359`) gains, documented in the same voice as the `email` group at
  `:400-420`:
  ```ts
  accountLinks?: {
    /** Register MANY providers. Merged AFTER env presets, so a same-id provider wins. */
    providers?: AccountLinkProvider[];
    /** In-process hooks. beforeLink is fail-closed; afterLink/afterUnlink fail-open (DECISIONS §9). */
    hooks?: AccountLinkHooks;
    /**
     * Extra allowed origins, concatenated AFTER ACCOUNT_LINK_ALLOWED_ORIGINS and
     * parsed by the same rule. A malformed entry THROWS at boot. This is the ONE
     * allowlist: PRD 07 checks `returnTo` against it, PRD 10 uses it as the
     * `postMessage` targetOrigin set, and PRD 10 validates its `resultRedirect`
     * against it. PRD 10 CONSUMES this field and does not redeclare it.
     */
    allowedOrigins?: string[];
  };
  ```
- `HogsendClient` (from `:162`) gains:
  ```ts
  accountLinkProviders: AccountLinkProviderRegistry;
  accountLinkHooks: AccountLinkHooks;
  /** Parsed + validated ACCOUNT_LINK_ALLOWED_ORIGINS. Empty array = none permitted. */
  accountLinkAllowedOrigins: string[];
  ```
- Build site placed immediately after the SMS registry block (`container.ts:901-906`) so all four
  registries read together:
  ```ts
  // PRD 06 prepends `...accountLinksFromEnv(env).providers` to this array.
  const accountLinkProviders = new AccountLinkProviderRegistry([
    ...(opts.accountLinks?.providers ?? []),
  ]);
  const accountLinkAllowedOrigins = parseAllowedOrigins([
    ...(env.ACCOUNT_LINK_ALLOWED_ORIGINS?.split(",") ?? []),
    ...(opts.accountLinks?.allowedOrigins ?? []),
  ]);
  ```
  Merge order is env-presets-first, consumer-last, identical to the email merge at `:1012-1016` and
  for the same load-bearing reason spelled out at `:1005-1011`. Leave the comment in place so PRD 06
  knows exactly where its one line goes.
- Duplicate-id warning: before constructing the registry, scan
  `opts.accountLinks?.providers ?? []` for a repeated `meta.id` and `logger.warn` once per
  duplicate.
- The unset-allowlist warning fires only when `accountLinkProviders.count() > 0`, so a deploy with no
  account linking at all stays silent.
- Add all three fields to the returned client object next to `smsProviders` (`:1651`) and
  `analyticsProviders` (`:1658`).

**No active-provider resolution.** Unlike email/SMS/analytics there is no single active account-link
provider: the player picks one per link, and the route resolves by `:provider` path param. So there
is deliberately no `ACCOUNT_LINK_PROVIDER` env and no "not registered" boot throw of the
`container.ts:1033-1038` shape. State this in the block comment so the next reader does not "fix" the
missing symmetry.

Tests `packages/engine/src/container.account-links.test.ts`:
- `exposes an empty registry and {} hooks with no config`
- `registers a consumer-supplied provider`
- `keeps the last of two consumer providers sharing an id, and warns once`
- `exposes accountLinkHooks verbatim`
- `parses ACCOUNT_LINK_ALLOWED_ORIGINS and the option into one list, env first`
- `throws at boot on a malformed allowed origin`
- `warns when providers are registered but the allowlist is empty`
- `stays silent when no providers are registered and the allowlist is empty`

The env-preset cases (`registers twitch + steam from env`, `a consumer provider of the same id
overrides the env preset`, `warns once on a half-configured twitch`) belong to PRD 06 T4, which
builds the presets. Do not write them here against providers that do not exist yet.

### T5 — Public surface export + changeset
_Boundary:_ `packages/engine`
_Depends:_ T4

Export `AccountLinkProviderRegistry` and re-export the PRD 01 types from
`packages/engine/src/index.ts` (the engine already re-exports `@hogsend/core` contracts this way).
Add `.changeset/*.md` for `@hogsend/engine` as a MINOR (additive public surface). Run `pnpm build`
per DECISIONS §4, since this touches the engine's public surface.

## Seams
None. Every task here is testable with fake env objects and hand-built `defineAccountLink` stubs
declared in the test file. Real Steam / Twitch credentials are the PRD 07 + PRD 16 seam, not this
one.

## Done when
- [ ] `packages/engine/src/lib/account-link-provider-registry.ts` + its test exist and pass.
- [ ] The six env vars are declared in `packages/engine/src/env.ts` with explanatory comments.
- [ ] `parseAllowedOrigins` lives in `lib/account-link-origins.ts`, THROWS on a malformed entry, and
      its throw is mutation-guarded by a test.
- [ ] `client.accountLinkProviders`, `client.accountLinkHooks`, `client.accountLinkAllowedOrigins`
      exist on `HogsendClient` and are populated per the merge order.
- [ ] `packages/engine/src/lib/account-links-from-env.ts` does NOT exist yet: it is PRD 06's file.
      `grep -rn "accountLinksFromEnv" packages/engine/src` returns only the placeholder comment at
      the container build site.
- [ ] Changeset added for `@hogsend/engine`.
- [ ] `pnpm lint`
- [ ] `pnpm check-types`
- [ ] `cd apps/api && pnpm test`
- [ ] `pnpm build` (engine public surface changed)
- [ ] `pnpm --filter @hogsend/engine test` (the engine's own `tsx --test` suite)

## Implementation Notes

### Verification

Five gates green, both the build and the cross-package test run FORCED uncached (a cached
`FULL TURBO` proves nothing about uncommitted work):
`lint`, `packages/engine tsc --noEmit`, full `apps/api` suite,
`turbo run test --filter='!@hogsend/api' --force` (46/46), `build --force` (29/29).

Mutation guard: disabling the explicit wildcard pre-check in `parseAllowedOrigins` fails exactly
`throws on a wildcard host` (7 pass -> 6 pass / 1 fail). That guard earns its place —
`new URL("https://*.example.com")` PARSES and its origin round-trips, so the round-trip check alone
would wave a wildcard host straight into a `postMessage` targetOrigin. Restored, 7/7.

Reviewed by hand against the PRD's six risk points: the 05/06 boundary holds (none of PRD 06's files
exist), no Discord anywhere, `STEAM_WEB_API_KEY` declared OPTIONAL and non-gating, hooks held but
invoked by nobody (the store remains the sole invoker), and the allowlist fails loud.

### A methodology failure worth recording

The full `apps/api` suite showed `contact-id-backfill` failing, and an A/B (fail with PRD 05, pass at
HEAD) looked like conclusive attribution. It was not: the delivery agent was STILL WRITING FILES
after sending an idle notification, so vitest was loading a moving target mid-run. With file content
pinned by checksum before and after, the suite passes with PRD 05 present.

Two rules follow, both of which had already bitten this stack once before being applied:
1. **An idle notification does not mean an agent has stopped.** Checksum the files before and after
   any gate run whose result you intend to act on.
2. **Never run gates while a writer is active**, and never `git stash` in that window — the pop
   failed here because the agent had rewritten the stashed files underneath; contents happened to be
   byte-identical so nothing was lost, but that was luck.

The two remaining full-suite failures are pre-existing and NOT from this PRD: `health-activity`
(fails identically at HEAD) and `gtm-score-batch` (passes alone in ~5s, times out only under
full-suite DB contention).
