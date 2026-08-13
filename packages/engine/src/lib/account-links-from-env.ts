import type { AccountLinkProvider } from "@hogsend/core";
import { steamAccountLink } from "../account-links/steam.js";
import { twitchAccountLink } from "../account-links/twitch.js";
import type { env as envSchema } from "../env.js";

export interface AccountLinkEnvResult {
  providers: AccountLinkProvider[];
  /** One line per partially-configured provider. The container logs each ONCE. */
  warnings: string[];
}

/**
 * Build the env-enabled account-link provider presets. Structural mirror of
 * `emailProvidersFromEnv` (`lib/email-providers-from-env.ts`), with two
 * deliberate divergences:
 *
 * 1. **Static imports.** No `loadOptionalPlugin`, no runtime-assembled
 *    specifier, because Steam and Twitch are IN-PACKAGE config over the
 *    `@hogsend/core` presets, not opt-in plugin packages (DECISIONS §3.1). No
 *    top-level `await`, so `createHogsendClient` stays synchronous.
 * 2. **It returns warnings rather than calling `console.warn`.** The email
 *    preset builder warns straight to `console.warn` because it runs before a
 *    logger exists; here the container already has `logger`, so the strings
 *    come back and the container logs them through the real logger. That keeps
 *    this function pure and unit-testable with no console spy.
 *
 * Rules:
 * - **Steam is registered UNCONDITIONALLY.** "Sign in through Steam" is
 *   OpenID 2.0: the relying party presents no credential of any kind — no app
 *   registration, no client id, no secret. The whole security model is the
 *   server-side `check_authentication` round-trip, unauthenticated by design.
 *   `STEAM_WEB_API_KEY` is OPTIONAL and WIDENS the provider (persona/avatar
 *   pull + the playtime sync) rather than enabling it — the preset branches on
 *   it, so it is passed straight through, not re-derived here. The only
 *   genuine requirement is the realm: `API_PUBLIC_URL` (already required by
 *   the engine env), trailing slash stripped — Steam rejects the assertion
 *   under a wrong realm. Steam contributes no warning and cannot be
 *   half-configured.
 * - Twitch is registered iff BOTH `ACCOUNT_LINK_TWITCH_CLIENT_ID` and
 *   `ACCOUNT_LINK_TWITCH_CLIENT_SECRET` are set. Exactly one set ⇒ no
 *   registration (absent from the registry, not present-but-disabled) plus a
 *   warning naming the MISSING var.
 * - Steam and twitch are the ONLY branches, by decision (DECISIONS §12): a
 *   platform whose linking already ships elsewhere in this repo keeps its one
 *   writer, so no third branch is added here.
 *
 * These presets come FIRST in the container's merge — a consumer-supplied
 * provider of the same id wins (last-writer-wins on the registry).
 */
export function accountLinksFromEnv(
  env: typeof envSchema,
): AccountLinkEnvResult {
  const providers: AccountLinkProvider[] = [];
  const warnings: string[] = [];

  providers.push(
    steamAccountLink({
      // Same normalization the SMS webhook route applies: the one
      // operator-controlled degree of freedom is a trailing slash.
      realm: env.API_PUBLIC_URL.replace(/\/+$/, ""),
      ...(env.STEAM_WEB_API_KEY ? { webApiKey: env.STEAM_WEB_API_KEY } : {}),
    }),
  );

  const twitchClientId = env.ACCOUNT_LINK_TWITCH_CLIENT_ID;
  const twitchClientSecret = env.ACCOUNT_LINK_TWITCH_CLIENT_SECRET;
  if (twitchClientId && twitchClientSecret) {
    providers.push(
      twitchAccountLink({
        clientId: twitchClientId,
        clientSecret: twitchClientSecret,
      }),
    );
  } else if (twitchClientId || twitchClientSecret) {
    const missing = twitchClientId
      ? "ACCOUNT_LINK_TWITCH_CLIENT_SECRET"
      : "ACCOUNT_LINK_TWITCH_CLIENT_ID";
    warnings.push(
      `twitch account linking is half-configured: ${missing} is unset, so ` +
        "the twitch provider is NOT registered. Set both " +
        "ACCOUNT_LINK_TWITCH_CLIENT_ID and ACCOUNT_LINK_TWITCH_CLIENT_SECRET " +
        "(from https://dev.twitch.tv/console/apps), or unset both",
    );
  }

  return { providers, warnings };
}
