import type { AccountLinkProvider } from "@hogsend/core";
import { battlenetAccountLink } from "../account-links/battlenet.js";
import { epicAccountLink } from "../account-links/epic.js";
import { riotAccountLink } from "../account-links/riot.js";
import { steamAccountLink } from "../account-links/steam.js";
import { twitchAccountLink } from "../account-links/twitch.js";
import { xboxAccountLink } from "../account-links/xbox.js";
import type { env as envSchema } from "../env.js";

export interface AccountLinkEnvResult {
  providers: AccountLinkProvider[];
  /** One line per partially-configured provider. The container logs each ONCE. */
  warnings: string[];
}

export interface AccountLinksFromEnvOptions {
  /**
   * True when the consumer passed ANY `accountLinks` option to
   * `createHogsendClient` — even `accountLinks: {}`. Code-side intent: an
   * operator who mentioned the feature gets the presets.
   */
  consumerOptedIn?: boolean;
}

/**
 * The env vars whose PRESENCE signals the operator wants account linking.
 * `ACCOUNT_LINK_STATE_TTL_SECONDS` is deliberately NOT here: it carries
 * `.default(900)` in the schema, so the parsed value is ALWAYS truthy and
 * counting it would make the intent gate vacuously true — exactly the
 * register-on-every-deploy bug this gate removes. (If it ever must count,
 * read the raw `process.env` key to distinguish set from defaulted.)
 */
function hasEnvIntent(env: typeof envSchema): boolean {
  return Boolean(
    env.ACCOUNT_LINK_TWITCH_CLIENT_ID ||
      env.ACCOUNT_LINK_TWITCH_CLIENT_SECRET ||
      env.STEAM_WEB_API_KEY ||
      env.ACCOUNT_LINK_BATTLENET_CLIENT_ID ||
      env.ACCOUNT_LINK_BATTLENET_CLIENT_SECRET ||
      env.ACCOUNT_LINK_EPIC_CLIENT_ID ||
      env.ACCOUNT_LINK_EPIC_CLIENT_SECRET ||
      env.ACCOUNT_LINK_XBOX_CLIENT_ID ||
      env.ACCOUNT_LINK_XBOX_CLIENT_SECRET ||
      env.ACCOUNT_LINK_RIOT_CLIENT_ID ||
      env.ACCOUNT_LINK_RIOT_CLIENT_SECRET ||
      env.ACCOUNT_LINK_ALLOWED_ORIGINS,
  );
}

/**
 * Build the env-enabled account-link provider presets. Structural mirror of
 * `emailProvidersFromEnv` (`lib/email-providers-from-env.ts`), with two
 * deliberate divergences:
 *
 * 1. **Static imports.** No `loadOptionalPlugin`, no runtime-assembled
 *    specifier, because the six built-in providers are IN-PACKAGE config over
 *    the `@hogsend/core` presets, not opt-in plugin packages (DECISIONS §3.1).
 *    No top-level `await`, so `createHogsendClient` stays synchronous.
 * 2. **It returns warnings rather than calling `console.warn`.** The email
 *    preset builder warns straight to `console.warn` because it runs before a
 *    logger exists; here the container already has `logger`, so the strings
 *    come back and the container logs them through the real logger. That keeps
 *    this function pure and unit-testable with no console spy.
 *
 * Rules:
 * - **Presets register only when the operator shows INTENT** in account links,
 *   preserving this repo's inert-when-unconfigured posture: a deploy that
 *   never asked for account linking gets no public `/v1/accounts/*` surface
 *   and no boot warning. Intent is EITHER env-side ({@link hasEnvIntent}: any
 *   `ACCOUNT_LINK_*` var, `STEAM_WEB_API_KEY`, or
 *   `ACCOUNT_LINK_ALLOWED_ORIGINS` set) OR code-side
 *   ({@link AccountLinksFromEnvOptions.consumerOptedIn}: any `accountLinks`
 *   option passed, even `{}`). No intent ⇒ empty result.
 * - **Steam stays credential-free** and registers on ANY intent. "Sign in
 *   through Steam" is OpenID 2.0: the relying party presents no credential of
 *   any kind — no app registration, no client id, no secret. The whole
 *   security model is the server-side `check_authentication` round-trip,
 *   unauthenticated by design. `STEAM_WEB_API_KEY` is OPTIONAL and WIDENS the
 *   provider (persona/avatar pull + the playtime sync) rather than enabling
 *   it — the preset branches on it, so it is passed straight through, not
 *   re-derived here. The only genuine requirement is the realm:
 *   `API_PUBLIC_URL` (already required by the engine env), trailing slash
 *   stripped — Steam rejects the assertion under a wrong realm. Steam
 *   contributes no warning and cannot be half-configured.
 * - OAuth providers (Twitch, Battle.net, Epic, Xbox, Riot) are registered iff
 *   BOTH `ACCOUNT_LINK_<ID>_CLIENT_ID` and `_CLIENT_SECRET` are set. Exactly
 *   one set ⇒ no registration (absent from the registry, not
 *   present-but-disabled) plus a warning naming the MISSING var.
 * - Discord is the only excluded platform: it already ships via
 *   `plugin-discord`, and a second writer on `contacts.discordId` would drift.
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
export function accountLinksFromEnv(
  env: typeof envSchema,
  options: AccountLinksFromEnvOptions = {},
): AccountLinkEnvResult {
  const providers: AccountLinkProvider[] = [];
  const warnings: string[] = [];

  if (!hasEnvIntent(env) && options.consumerOptedIn !== true) {
    return { providers, warnings };
  }

  providers.push(
    steamAccountLink({
      // Same normalization the SMS webhook route applies: the one
      // operator-controlled degree of freedom is a trailing slash.
      realm: env.API_PUBLIC_URL.replace(/\/+$/, ""),
      ...(env.STEAM_WEB_API_KEY ? { webApiKey: env.STEAM_WEB_API_KEY } : {}),
    }),
  );

  const oauthPresets: Array<{
    id: string;
    clientId: string | undefined;
    clientSecret: string | undefined;
    idVar: string;
    secretVar: string;
    factory: (cfg: {
      clientId: string;
      clientSecret: string;
    }) => AccountLinkProvider;
    portal: string;
  }> = [
    {
      id: "twitch",
      clientId: env.ACCOUNT_LINK_TWITCH_CLIENT_ID,
      clientSecret: env.ACCOUNT_LINK_TWITCH_CLIENT_SECRET,
      idVar: "ACCOUNT_LINK_TWITCH_CLIENT_ID",
      secretVar: "ACCOUNT_LINK_TWITCH_CLIENT_SECRET",
      factory: twitchAccountLink,
      portal: "https://dev.twitch.tv/console/apps",
    },
    {
      id: "battlenet",
      clientId: env.ACCOUNT_LINK_BATTLENET_CLIENT_ID,
      clientSecret: env.ACCOUNT_LINK_BATTLENET_CLIENT_SECRET,
      idVar: "ACCOUNT_LINK_BATTLENET_CLIENT_ID",
      secretVar: "ACCOUNT_LINK_BATTLENET_CLIENT_SECRET",
      factory: battlenetAccountLink,
      portal: "https://develop.battle.net/access",
    },
    {
      id: "epic",
      clientId: env.ACCOUNT_LINK_EPIC_CLIENT_ID,
      clientSecret: env.ACCOUNT_LINK_EPIC_CLIENT_SECRET,
      idVar: "ACCOUNT_LINK_EPIC_CLIENT_ID",
      secretVar: "ACCOUNT_LINK_EPIC_CLIENT_SECRET",
      factory: epicAccountLink,
      portal: "https://dev.epicgames.com/portal",
    },
    {
      id: "xbox",
      clientId: env.ACCOUNT_LINK_XBOX_CLIENT_ID,
      clientSecret: env.ACCOUNT_LINK_XBOX_CLIENT_SECRET,
      idVar: "ACCOUNT_LINK_XBOX_CLIENT_ID",
      secretVar: "ACCOUNT_LINK_XBOX_CLIENT_SECRET",
      factory: xboxAccountLink,
      portal: "https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps",
    },
    {
      id: "riot",
      clientId: env.ACCOUNT_LINK_RIOT_CLIENT_ID,
      clientSecret: env.ACCOUNT_LINK_RIOT_CLIENT_SECRET,
      idVar: "ACCOUNT_LINK_RIOT_CLIENT_ID",
      secretVar: "ACCOUNT_LINK_RIOT_CLIENT_SECRET",
      factory: riotAccountLink,
      portal: "https://developer.riotgames.com",
    },
  ];

  for (const p of oauthPresets) {
    if (p.clientId && p.clientSecret) {
      providers.push(
        p.factory({ clientId: p.clientId, clientSecret: p.clientSecret }),
      );
    } else if (p.clientId || p.clientSecret) {
      const missing = p.clientId ? p.secretVar : p.idVar;
      warnings.push(
        `${p.id} account linking is half-configured: ${missing} is unset, ` +
          `so the ${p.id} provider is NOT registered. Set both ${p.idVar} ` +
          `and ${p.secretVar} (from ${p.portal}), or unset both`,
      );
    }
  }

  return { providers, warnings };
}
