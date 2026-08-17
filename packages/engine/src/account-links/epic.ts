import {
  AccountLinkCallbackError,
  type AccountLinkProvider,
  type LinkedIdentity,
  oauth2Link,
} from "@hogsend/core";

/**
 * Epic Games app credentials, from an application registered at
 * `https://dev.epicgames.com/portal` with OAuth redirect URL
 * `<API_PUBLIC_URL>/v1/accounts/epic/callback`. Env spelling:
 * `ACCOUNT_LINK_EPIC_CLIENT_ID` / `ACCOUNT_LINK_EPIC_CLIENT_SECRET`
 * (see `lib/account-links-from-env.ts` — registered only when BOTH are set).
 */
export interface EpicAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}

/** The slice of an Epic `/oauth/verify` response this mapping reads. */
interface EpicVerifyUser {
  accountId?: string;
  account_id?: string;
  displayName?: string;
  display_name?: string;
}

/**
 * Map an Epic `GET /oauth/verify` response onto a {@link LinkedIdentity}.
 * Exported for direct unit testing — it is the only real logic in this file.
 *
 * - `providerUserId` is Epic's `accountId`, the IMMUTABLE key. Never
 *   `displayName`: it is user-editable, so keying on it lets a player rename
 *   themselves onto another player's link row.
 * - Epic's verify endpoint returns camelCase (`accountId`, `displayName`) but
 *   we defensively check snake_case variants too.
 */
export function mapEpicUser(json: unknown): Omit<LinkedIdentity, "tokens"> {
  const user = json as EpicVerifyUser | null | undefined;
  const id = user?.accountId ?? user?.account_id;
  if (!id) {
    throw new AccountLinkCallbackError(
      "exchange_failed",
      "Epic /oauth/verify returned no accountId for the presented token",
    );
  }
  const username = user?.displayName ?? user?.display_name;
  return {
    providerUserId: id,
    ...(username ? { username } : {}),
  };
}

/**
 * The Epic Games account-link provider: pure CONFIG over the `oauth2Link()`
 * preset (OAuth2 authorization code, tokens sealed). All protocol mechanics
 * — authorize URL, token exchange, `error=access_denied` mapping, the
 * userinfo fetch — live in the preset
 * (`@hogsend/core`, `providers/account-link-presets.ts`), not here.
 *
 * Epic does not support PKCE for confidential clients, so `usePkce` is false.
 * The verify endpoint returns the authenticated user's identity from the
 * bearer token alone — no extra headers needed.
 */
export function epicAccountLink(
  config: EpicAccountLinkConfig,
): AccountLinkProvider {
  return oauth2Link({
    meta: {
      id: "epic",
      name: "Epic Games",
      description: "Link an Epic Games account (OAuth2)",
    },
    authorizeEndpoint: "https://www.epicgames.com/id/authorize",
    tokenEndpoint:
      "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/token",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["basic_profile"],
    usePkce: false,
    storeTokens: true,
    userInfo: {
      url: "https://account-public-service-prod03.ol.epicgames.com/account/api/oauth/verify",
      map: mapEpicUser,
    },
  });
}
