import {
  AccountLinkCallbackError,
  type AccountLinkProvider,
  type LinkedIdentity,
  oauth2Link,
} from "@hogsend/core";

/**
 * Microsoft (Xbox) app credentials, from an application registered at
 * `https://portal.azure.com` → App registrations with OAuth redirect URL
 * `<API_PUBLIC_URL>/v1/accounts/xbox/callback`. The app MUST allow
 * "personal Microsoft accounts" (consumers tenant). Env spelling:
 * `ACCOUNT_LINK_XBOX_CLIENT_ID` / `ACCOUNT_LINK_XBOX_CLIENT_SECRET`
 * (see `lib/account-links-from-env.ts` — registered only when BOTH are set).
 */
export interface XboxAccountLinkConfig {
  clientId: string;
  clientSecret: string;
}

/** The slice of a Microsoft Graph `GET /v1.0/me` response this mapping reads. */
interface GraphUser {
  id?: string;
  displayName?: string;
  userPrincipalName?: string;
}

/**
 * Map a Microsoft Graph `GET /v1.0/me` response onto a {@link LinkedIdentity}.
 * Exported for direct unit testing — it is the only real logic in this file.
 *
 * - `providerUserId` is Graph's `id` (the IMMUTABLE Azure AD object id). This
 *   is the same identity that owns the Xbox account — personal Microsoft
 *   accounts are the backing identity for Xbox Live.
 * - `userPrincipalName` is a PROPERTY, never an identity key and never
 *   `verifiedEmail`: Graph returns the primary email but DECISIONS §6.4 makes
 *   a provider-reported email a property regardless. It lands in
 *   `properties.xbox_email`.
 */
export function mapXboxUser(json: unknown): Omit<LinkedIdentity, "tokens"> {
  const user = json as GraphUser | null | undefined;
  if (!user?.id) {
    throw new AccountLinkCallbackError(
      "exchange_failed",
      "Microsoft Graph /me returned no id for the presented token",
    );
  }
  return {
    providerUserId: user.id,
    ...(user.displayName ? { username: user.displayName } : {}),
    ...(user.userPrincipalName
      ? { properties: { xbox_email: user.userPrincipalName } }
      : {}),
  };
}

/**
 * The Xbox account-link provider: pure CONFIG over the `oauth2Link()` preset
 * (OAuth2 authorization code + PKCE, tokens sealed). All protocol mechanics —
 * authorize URL, token exchange, `error=access_denied` mapping, the userinfo
 * fetch — live in the preset (`@hogsend/core`, `providers/account-link-presets.ts`),
 * not here.
 *
 * Uses the Microsoft `/consumers` tenant so ONLY personal Microsoft accounts
 * (which back Xbox Live) are accepted — work/school accounts are rejected at
 * the authorize step by Microsoft itself.
 */
export function xboxAccountLink(
  config: XboxAccountLinkConfig,
): AccountLinkProvider {
  return oauth2Link({
    meta: {
      id: "xbox",
      name: "Xbox",
      description: "Link an Xbox account (OAuth2 via Microsoft)",
    },
    authorizeEndpoint:
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize",
    tokenEndpoint:
      "https://login.microsoftonline.com/consumers/oauth2/v2.0/token",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    scopes: ["User.Read", "offline_access"],
    usePkce: true,
    storeTokens: true,
    authorizeParams: { prompt: "select_account" },
    userInfo: {
      url: "https://graph.microsoft.com/v1.0/me",
      map: mapXboxUser,
    },
  });
}
