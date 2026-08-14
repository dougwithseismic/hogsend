import { type AccountLinkProvider, steamOpenIdLink } from "@hogsend/core";

export interface SteamAccountLinkConfig {
  /**
   * Steam Web API key (`https://steamcommunity.com/dev/apikey`). OPTIONAL —
   * it never gates the link itself. Absent: linking works and the identity is
   * the bare 17-digit steamid64. Present: the best-effort
   * `GetPlayerSummaries` pull fills `username`/`avatarUrl` and the
   * `steam_playtime_2wk` property sync attaches.
   */
  webApiKey?: string;
  /** The `openid.realm` this deployment presents. `API_PUBLIC_URL`, trailing slash stripped. */
  realm: string;
}

/**
 * The Steam account-link provider: pure CONFIG over the `steamOpenIdLink()`
 * preset. "Sign in through Steam" is OpenID 2.0 `checkid_setup`, so three
 * things a reader will come looking for are structurally absent:
 *
 * - There is NO `code` and NO PKCE — OpenID 2.0 has neither, so PRD 07 skips
 *   its PKCE mint for this provider (`capabilities.pkce` absent).
 * - There is NO token — OpenID 2.0 issues nothing to store, so
 *   `capabilities.tokens` is absent and PRD 03 writes a null
 *   `linked_accounts.tokens`.
 * - The relying party presents NO credential: no app registration, no client
 *   id, no secret. The entire security model is the preset's server-side
 *   `check_authentication` round-trip against Steam's HARDCODED endpoint
 *   (`STEAM_OPENID_ENDPOINT`), never the callback-echoed `openid.op_endpoint`.
 *
 * All protocol mechanics — the `checkid_setup` URL, the round-trip, the strict
 * `parseSteamClaimedId` anchor, the `return_to` echo check, the `mode=cancel`
 * mapping, the playtime sync reader — live in the preset
 * (`@hogsend/core`, `providers/account-link-presets.ts`), not here.
 */
export function steamAccountLink(
  config: SteamAccountLinkConfig,
): AccountLinkProvider {
  return steamOpenIdLink({
    meta: {
      id: "steam",
      name: "Steam",
      description: "Sign in through Steam (OpenID 2.0)",
    },
    realm: config.realm,
    ...(config.webApiKey ? { webApiKey: config.webApiKey } : {}),
  });
}
