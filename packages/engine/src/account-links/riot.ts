import {
  AccountLinkCallbackError,
  type AccountLinkProvider,
  type LinkedIdentity,
  oauth2Link,
} from "@hogsend/core";

/**
 * Riot Games app credentials, from an application registered at
 * `https://developer.riotgames.com/` with OAuth redirect URL
 * `<API_PUBLIC_URL>/v1/accounts/riot/callback`. Env spelling:
 * `ACCOUNT_LINK_RIOT_CLIENT_ID` / `ACCOUNT_LINK_RIOT_CLIENT_SECRET`
 * (see `lib/account-links-from-env.ts` — registered only when BOTH are set).
 */
export interface RiotAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}

/** The slice of an RSO `/userinfo` response this mapping reads. */
interface RsoUserInfo {
  sub?: string;
  puuid?: string;
  cpid?: string;
}

/**
 * Map an RSO `GET /userinfo` response onto a {@link LinkedIdentity}.
 * Exported for direct unit testing — it is the only real logic in this file.
 *
 * - `providerUserId` is the PUUID (`sub`), the IMMUTABLE key. Riot returns it
 *   as `sub` in the OpenID Connect userinfo response; some endpoint versions
 *   also surface it as `puuid`. Never `cpid`: that is a legacy id.
 * - Riot's userinfo endpoint does NOT return a gameName or tagLine, so no
 *   `username` is set. The PUUID alone is sufficient for the link row.
 */
export function mapRiotUser(json: unknown): Omit<LinkedIdentity, "tokens"> {
  const info = json as RsoUserInfo | null | undefined;
  const puuid = info?.sub || info?.puuid;
  if (!puuid) {
    throw new AccountLinkCallbackError(
      "exchange_failed",
      "RSO /userinfo returned no sub or puuid for the presented token",
    );
  }
  return {
    providerUserId: puuid,
  };
}

/**
 * The Riot Games account-link provider: pure CONFIG over the `oauth2Link()`
 * preset (OAuth2 authorization code + PKCE, tokens sealed). All protocol
 * mechanics — authorize URL, token exchange, `error=access_denied` mapping,
 * the userinfo fetch — live in the preset
 * (`@hogsend/core`, `providers/account-link-presets.ts`), not here.
 *
 * RSO (Riot Sign On) is standard OAuth2 / OpenID Connect. The `openid` scope
 * gives access to the `/userinfo` endpoint which returns the PUUID as `sub`.
 */
export function riotAccountLink(
  config: RiotAccountLinkConfig,
): AccountLinkProvider {
  return oauth2Link({
    meta: {
      id: "riot",
      name: "Riot Games",
      description: "Link a Riot Games account (RSO OAuth2)",
    },
    authorizeEndpoint: "https://auth.riotgames.com/authorize",
    tokenEndpoint: "https://auth.riotgames.com/token",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["openid"],
    usePkce: true,
    storeTokens: true,
    userInfo: {
      url: "https://auth.riotgames.com/userinfo",
      map: mapRiotUser,
    },
  });
}
