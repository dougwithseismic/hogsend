import {
  AccountLinkCallbackError,
  type AccountLinkProvider,
  type LinkedIdentity,
  oauth2Link,
} from "@hogsend/core";

/**
 * Twitch app credentials, from an application registered at
 * `https://dev.twitch.tv/console/apps` with OAuth redirect URL
 * `<API_PUBLIC_URL>/v1/accounts/twitch/callback`. Env spelling:
 * `ACCOUNT_LINK_TWITCH_CLIENT_ID` / `ACCOUNT_LINK_TWITCH_CLIENT_SECRET`
 * (see `lib/account-links-from-env.ts` — registered only when BOTH are set).
 */
export interface TwitchAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}

/** The slice of a Helix `GET /helix/users` row this mapping reads. */
interface HelixUser {
  id?: string;
  login?: string;
  display_name?: string;
  profile_image_url?: string;
  email?: string;
}

/**
 * Map a Helix `GET /helix/users` response onto a {@link LinkedIdentity}.
 * Exported for direct unit testing — it is the only real logic in this file.
 *
 * - `providerUserId` is Helix's numeric `id`, the IMMUTABLE key. Never `login`
 *   or `display_name`: both are user-editable, so keying on one lets a player
 *   rename themselves onto another player's link row.
 * - The email is a PROPERTY, never an identity key and never `verifiedEmail`:
 *   Helix returns `email` under the `user:read:email` scope but exposes no
 *   per-address verification boolean, and DECISIONS §6.4 makes a
 *   provider-reported email a property regardless. It lands in
 *   `properties.twitch_email`.
 */
export function mapTwitchUser(json: unknown): Omit<LinkedIdentity, "tokens"> {
  const user = (json as { data?: HelixUser[] } | null | undefined)?.data?.[0];
  if (!user?.id) {
    // An empty `data` array with a 200 status happens when the token's user
    // was deleted mid-flow. An identity with an empty providerUserId would
    // key a link row on "", so throw instead.
    throw new AccountLinkCallbackError(
      "exchange_failed",
      "Helix /users returned no user for the presented token",
    );
  }
  const username = user.display_name || user.login;
  return {
    providerUserId: user.id,
    ...(username ? { username } : {}),
    ...(user.profile_image_url ? { avatarUrl: user.profile_image_url } : {}),
    ...(user.email ? { properties: { twitch_email: user.email } } : {}),
  };
}

/**
 * The Twitch account-link provider: pure CONFIG over the `oauth2Link()` preset
 * (OAuth2 authorization code + PKCE, tokens sealed, revoke on unlink). All
 * protocol mechanics — authorize URL, token exchange, `error=access_denied`
 * mapping, the userinfo fetch — live in the preset
 * (`@hogsend/core`, `providers/account-link-presets.ts`), not here.
 *
 * `userInfo.headers` carries `Client-Id` because Helix 401s any request
 * without it; the preset merges it UNDER the `Authorization: Bearer` header.
 */
export function twitchAccountLink(
  config: TwitchAccountLinkConfig,
): AccountLinkProvider {
  return oauth2Link({
    meta: {
      id: "twitch",
      name: "Twitch",
      description: "Link a Twitch account (OAuth2 + PKCE)",
    },
    authorizeEndpoint: "https://id.twitch.tv/oauth2/authorize",
    tokenEndpoint: "https://id.twitch.tv/oauth2/token",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["user:read:email"],
    usePkce: true,
    storeTokens: true,
    // Without force_verify Twitch silently reuses the browser's live session,
    // which links whoever happens to be signed in — on a shared machine that
    // is the wrong account with no prompt.
    authorizeParams: { force_verify: "true" },
    revokeEndpoint: "https://id.twitch.tv/oauth2/revoke",
    userInfo: {
      url: "https://api.twitch.tv/helix/users",
      headers: { "Client-Id": config.clientId },
      map: mapTwitchUser,
    },
  });
}
