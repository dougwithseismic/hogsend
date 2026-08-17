import {
  AccountLinkCallbackError,
  type AccountLinkProvider,
  type LinkedIdentity,
  oauth2Link,
} from "@hogsend/core";

/**
 * Battle.net app credentials, from an application registered at
 * `https://develop.battle.net/access/clients` with OAuth redirect URL
 * `<API_PUBLIC_URL>/v1/accounts/battlenet/callback`. Env spelling:
 * `ACCOUNT_LINK_BATTLENET_CLIENT_ID` / `ACCOUNT_LINK_BATTLENET_CLIENT_SECRET`
 * (see `lib/account-links-from-env.ts` — registered only when BOTH are set).
 */
export interface BattlenetAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}

/** The slice of a Battle.net `/oauth/userinfo` response this mapping reads. */
interface BattlenetUserInfo {
  sub?: string;
  battletag?: string;
}

/**
 * Map a Battle.net `/oauth/userinfo` response onto a {@link LinkedIdentity}.
 * Exported for direct unit testing — it is the only real logic in this file.
 *
 * - `providerUserId` is the `sub` claim, the IMMUTABLE key. Never `battletag`:
 *   it is user-editable, so keying on it lets a player rename themselves onto
 *   another player's link row.
 * - `battletag` is a display name and lands in `username`, NOT `verifiedEmail`:
 *   the userinfo endpoint exposes no email verification info.
 */
export function mapBattlenetUser(
  json: unknown,
): Omit<LinkedIdentity, "tokens"> {
  const user = json as BattlenetUserInfo | null | undefined;
  if (!user?.sub) {
    throw new AccountLinkCallbackError(
      "exchange_failed",
      "Battle.net /oauth/userinfo returned no sub for the presented token",
    );
  }
  return {
    providerUserId: user.sub,
    ...(user.battletag ? { username: user.battletag } : {}),
  };
}

/**
 * The Battle.net account-link provider: pure CONFIG over the `oauth2Link()`
 * preset (OAuth2 authorization code + PKCE, tokens sealed). All protocol
 * mechanics — authorize URL, token exchange, `error=access_denied` mapping,
 * the userinfo fetch — live in the preset
 * (`@hogsend/core`, `providers/account-link-presets.ts`), not here.
 *
 * Battle.net has no standard token revocation endpoint, so `revokeEndpoint`
 * is omitted — unlinking destroys the stored tokens without calling the
 * provider.
 */
export function battlenetAccountLink(
  config: BattlenetAccountLinkConfig,
): AccountLinkProvider {
  return oauth2Link({
    meta: {
      id: "battlenet",
      name: "Battle.net",
      description: "Link a Battle.net account (OAuth2 + PKCE)",
    },
    authorizeEndpoint: "https://oauth.battle.net/authorize",
    tokenEndpoint: "https://oauth.battle.net/token",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["openid"],
    usePkce: true,
    storeTokens: true,
    userInfo: {
      url: "https://oauth.battle.net/oauth/userinfo",
      map: mapBattlenetUser,
    },
  });
}
