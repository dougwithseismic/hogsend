import { hours } from "../duration.js";
import {
  AccountLinkCallbackError,
  type AccountLinkMeta,
  type AccountLinkProvider,
  type AccountSyncArgs,
  defineAccountLink,
  type LinkedIdentity,
  type LinkTokens,
} from "./account-link.js";

// ---------------------------------------------------------------------------
// Shared helpers
//
// Both presets are pure apart from the INJECTED `fetchImpl`, so a provider can
// be exercised end to end with fixtures and no network and no credential.
// ---------------------------------------------------------------------------

/** `globalThis.fetch` unless the caller injected one (tests always do). */
function resolveFetch(fetchImpl?: typeof fetch): typeof fetch {
  return fetchImpl ?? globalThis.fetch;
}

/**
 * The only diagnostic a failed HTTP leg may carry.
 *
 * A raw OAuth error body can contain an access token (providers echo the
 * request, and some echo the grant), so it NEVER reaches a message, a log line
 * or an exception. Status code plus the endpoint HOST is enough to tell "Twitch
 * 503" from "our client secret is wrong" and carries no secret.
 */
function endpointFailure(endpoint: string, status: number): string {
  let host = "unknown-host";
  try {
    host = new URL(endpoint).host;
  } catch {
    // A malformed endpoint is a configuration bug, not a secret.
  }
  return `${host} responded ${status}`;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// OAuth2 preset
// ---------------------------------------------------------------------------

/** The raw token-endpoint response, before it becomes a {@link LinkTokens}. */
interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface OAuth2LinkConfig {
  meta: AccountLinkMeta;
  authorizeEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  usePkce?: boolean;
  /**
   * Extra static params on the authorize URL (`force_verify=true`, …). Applied
   * FIRST, so they can never clobber `client_id`, `redirect_uri`, `state` or
   * the PKCE challenge — a config typo must not be able to unpick the flow's
   * security parameters.
   */
  authorizeParams?: Record<string, string>;
  userInfo: {
    url: string;
    /**
     * Extra headers sent on the userinfo request, merged UNDER the
     * `Authorization: Bearer` header the preset sets (so a config can never
     * clobber the bearer). Twitch's Helix API returns 401 on any request
     * without `Client-Id`, so without this field the preset cannot express
     * Twitch at all and the engine would have to fork a bespoke provider.
     */
    headers?: Record<string, string>;
    /** Maps the platform's JSON onto a LinkedIdentity. MUST pick the immutable id. */
    map(json: unknown): Omit<LinkedIdentity, "tokens">;
  };
  /** Seal the grant into `linked_accounts.tokens`? Default false. */
  storeTokens?: boolean;
  multiple?: boolean;
  onConflict?: "replace" | "reject";
  revokeEndpoint?: string;
  sync?: AccountLinkProvider["sync"];
}

/**
 * A refresh failure that the caller can BRANCH on without string-matching a
 * body. `invalidGrant` is the "the player revoked us / changed their password"
 * signal: the link stays (it is an identity claim proven once) and only the
 * property sync dies. Everything else is a transient upstream failure and gets
 * retried.
 *
 * It extends {@link AccountLinkCallbackError} so a caller that only knows the
 * base type still sees `reason: "exchange_failed"`.
 */
export class AccountLinkTokenRefreshError extends AccountLinkCallbackError {
  readonly invalidGrant: boolean;

  constructor(message: string, invalidGrant: boolean) {
    super("exchange_failed", message);
    this.name = "AccountLinkTokenRefreshError";
    this.invalidGrant = invalidGrant;
  }
}

/**
 * Build an {@link AccountLinkProvider} for a standard OAuth2 authorization-code
 * platform (Twitch, and most others). The whole provider is this factory plus a
 * field mapping — which is exactly why account-link providers are config in the
 * engine rather than plugin packages.
 */
export function oauth2Link(config: OAuth2LinkConfig): AccountLinkProvider {
  const storeTokens = config.storeTokens === true;

  const exchange = async (
    body: URLSearchParams,
    fetchImpl: typeof fetch,
    invalidGrantOnFailure: boolean,
  ): Promise<TokenResponse> => {
    body.set("client_id", config.clientId);
    body.set("client_secret", config.clientSecret);
    const response = await fetchImpl(config.tokenEndpoint, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: body.toString(),
    });
    if (!response.ok) {
      // Read the body ONLY to classify; it is never interpolated anywhere.
      const raw = await response.text().catch(() => "");
      const message = endpointFailure(config.tokenEndpoint, response.status);
      if (invalidGrantOnFailure) {
        throw new AccountLinkTokenRefreshError(
          message,
          raw.includes("invalid_grant"),
        );
      }
      throw new AccountLinkCallbackError("exchange_failed", message);
    }
    const json = (await readJson(response)) as TokenResponse | undefined;
    if (!json?.access_token) {
      const message = `${endpointFailure(config.tokenEndpoint, response.status)} without an access token`;
      if (invalidGrantOnFailure) {
        throw new AccountLinkTokenRefreshError(message, false);
      }
      throw new AccountLinkCallbackError("exchange_failed", message);
    }
    return json;
  };

  const toTokens = (json: TokenResponse): LinkTokens => ({
    accessToken: json.access_token as string,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(typeof json.expires_in === "number"
      ? {
          expiresAt: new Date(
            Date.now() + json.expires_in * 1000,
          ).toISOString(),
        }
      : {}),
    ...(json.scope ? { scopes: json.scope.split(" ").filter(Boolean) } : {}),
  });

  return defineAccountLink({
    meta: config.meta,
    ...(storeTokens || config.usePkce
      ? {
          capabilities: {
            ...(storeTokens ? { tokens: true as const } : {}),
            ...(config.usePkce ? { pkce: true as const } : {}),
          },
        }
      : {}),
    ...(config.multiple !== undefined ? { multiple: config.multiple } : {}),
    ...(config.onConflict !== undefined
      ? { onConflict: config.onConflict }
      : {}),
    ...(config.sync ? { sync: config.sync } : {}),

    authorizeUrl({ state, redirectUri, codeChallenge }) {
      const url = new URL(config.authorizeEndpoint);
      // Extras first: the flow's own params overwrite them, never the reverse.
      for (const [key, value] of Object.entries(config.authorizeParams ?? {})) {
        url.searchParams.set(key, value);
      }
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", config.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("scope", config.scopes.join(" "));
      url.searchParams.set("state", state);
      if (config.usePkce) {
        if (!codeChallenge) {
          // Silently dropping PKCE would downgrade the flow to a plain code
          // grant while every log line still said "pkce". Fail loudly instead.
          throw new Error(
            `account link provider "${config.meta.id}" declares usePkce but ` +
              "authorizeUrl was called without a codeChallenge",
          );
        }
        url.searchParams.set("code_challenge", codeChallenge);
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url.toString();
    },

    async handleCallback({ query, redirectUri, codeVerifier, fetchImpl }) {
      const doFetch = resolveFetch(fetchImpl);

      // The player's own answer comes FIRST, before any network call: a
      // deliberate "no" is not a failure and must not read as an attack.
      if (query.error) {
        const denied =
          query.error === "access_denied" || query.error.endsWith("_denied");
        throw new AccountLinkCallbackError(
          denied ? "denied" : "exchange_failed",
          `authorization failed (${query.error})`,
        );
      }
      if (!query.code) {
        throw new AccountLinkCallbackError(
          "state_invalid",
          "callback carried neither a code nor an error",
        );
      }

      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: query.code,
        // Byte-identical to the authorize leg — providers compare it verbatim.
        redirect_uri: redirectUri,
      });
      if (config.usePkce && codeVerifier) {
        body.set("code_verifier", codeVerifier);
      }
      const token = await exchange(body, doFetch, false);

      const profile = await doFetch(config.userInfo.url, {
        method: "GET",
        headers: {
          // Config headers first so the bearer wins any key collision: a
          // provider config must never be able to send someone else's token.
          ...(config.userInfo.headers ?? {}),
          Authorization: `Bearer ${token.access_token}`,
        },
      });
      if (!profile.ok) {
        throw new AccountLinkCallbackError(
          "exchange_failed",
          endpointFailure(config.userInfo.url, profile.status),
        );
      }
      const identity = config.userInfo.map(await readJson(profile));

      return storeTokens
        ? { ...identity, tokens: toTokens(token) }
        : { ...identity };
    },

    ...(storeTokens
      ? {
          async refresh(tokens: LinkTokens, fetchImpl?: typeof fetch) {
            if (!tokens.refreshToken) {
              // Nothing to refresh with is the same OUTCOME as a dead refresh
              // token, so it takes the same branch: keep the link, kill the
              // sync.
              throw new AccountLinkTokenRefreshError(
                "no refresh token stored for this link",
                true,
              );
            }
            const body = new URLSearchParams({
              grant_type: "refresh_token",
              refresh_token: tokens.refreshToken,
            });
            return toTokens(
              await exchange(body, resolveFetch(fetchImpl), true),
            );
          },
        }
      : {}),

    ...(storeTokens && config.revokeEndpoint
      ? {
          async revoke(tokens: LinkTokens, fetchImpl?: typeof fetch) {
            // Best effort by contract: an already-expired or already-revoked
            // token answers 4xx at several platforms, and that is the outcome
            // we wanted anyway. A transport error still propagates.
            const revokeEndpoint = config.revokeEndpoint as string;
            await resolveFetch(fetchImpl)(revokeEndpoint, {
              method: "POST",
              headers: {
                "content-type": "application/x-www-form-urlencoded",
              },
              body: new URLSearchParams({
                token: tokens.accessToken,
                client_id: config.clientId,
                client_secret: config.clientSecret,
              }).toString(),
            });
          },
        }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// Steam OpenID 2.0 preset
// ---------------------------------------------------------------------------

/**
 * Steam's OpenID 2.0 endpoint, HARDCODED.
 *
 * This is the load-bearing constant of the whole preset. The
 * `check_authentication` round trip exists to ask STEAM whether an assertion it
 * supposedly issued is genuine. If the callback got to name who answers that
 * question — via `openid.op_endpoint`, which is attacker-controlled like every
 * other callback parameter — an attacker points it at a server they control, it
 * replies `is_valid:true` to their own forged assertion, and they link ANY
 * steamid64 to ANY contact. The verification would then certify nothing while
 * looking exactly like it works, which is worse than not verifying at all.
 *
 * It is deliberately NOT configurable "for tests": inject `fetchImpl` instead,
 * which is what `HandleCallbackArgs.fetchImpl` exists for. A config field would
 * be one deploy-time typo away from the same hole.
 */
export const STEAM_OPENID_ENDPOINT = "https://steamcommunity.com/openid/login";

const OPENID_NS = "http://specs.openid.net/auth/2.0";
const OPENID_IDENTIFIER_SELECT = `${OPENID_NS}/identifier_select`;
const STEAM_API_BASE = "https://api.steampowered.com";

/**
 * Anchored on BOTH ends deliberately: an unanchored pattern accepts
 * `https://evil.example/?x=https://steamcommunity.com/openid/id/7656…` and
 * hands an attacker any steamid64 they can type. Returns the 17-digit
 * steamid64, or `null` for anything else.
 */
export const STEAM_CLAIMED_ID_RE =
  /^https:\/\/steamcommunity\.com\/openid\/id\/(\d{17})$/;

export function parseSteamClaimedId(claimedId: string): string | null {
  return STEAM_CLAIMED_ID_RE.exec(claimedId)?.[1] ?? null;
}

/**
 * The `openid.return_to` this deployment presents for one attempt.
 *
 * OpenID 2.0 has NO `state` parameter, so the engine's signed state rides in
 * `return_to` and that value is the ONLY channel binding this leg has. Exported
 * so the callback route builds the SAME string it presented, byte for byte, and
 * the comparison in `handleCallback` stays meaningful.
 */
export function steamReturnTo(redirectUri: string, state: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface SteamOpenIdLinkConfig {
  /** Defaults to `{ id: "steam", name: "Steam" }`. */
  meta?: AccountLinkMeta;
  /** Steam Web API key, used for the profile fetch and the property sync. */
  webApiKey?: string;
  /** The `openid.realm` this deployment presents. */
  realm: string;
  multiple?: boolean;
  onConflict?: "replace" | "reject";
}

interface SteamPlayerSummary {
  personaname?: string;
  avatarfull?: string;
}

/**
 * Build the Steam provider. Steam is OpenID 2.0, not OAuth2 — which is exactly
 * why the primitive is `defineAccountLink` and not `defineOAuthLink`. It yields
 * NO email and NO tokens, ever, so nothing is sealed and
 * `capabilities.tokens` is deliberately absent.
 */
export function steamOpenIdLink(
  config: SteamOpenIdLinkConfig,
): AccountLinkProvider {
  const meta = config.meta ?? { id: "steam", name: "Steam" };

  /** Display-only decoration. A failure must never fail the LINK. */
  const fetchProfile = async (
    steamId: string,
    doFetch: typeof fetch,
  ): Promise<{ username?: string; avatarUrl?: string }> => {
    if (!config.webApiKey) return {};
    try {
      const url = new URL(
        `${STEAM_API_BASE}/ISteamUser/GetPlayerSummaries/v2/`,
      );
      url.searchParams.set("key", config.webApiKey);
      url.searchParams.set("steamids", steamId);
      const response = await doFetch(url.toString(), { method: "GET" });
      if (!response.ok) return {};
      const json = (await readJson(response)) as
        | { response?: { players?: SteamPlayerSummary[] } }
        | undefined;
      const player = json?.response?.players?.[0];
      return {
        ...(player?.personaname ? { username: player.personaname } : {}),
        ...(player?.avatarfull ? { avatarUrl: player.avatarfull } : {}),
      };
    } catch {
      return {};
    }
  };

  return defineAccountLink({
    meta,
    ...(config.multiple !== undefined ? { multiple: config.multiple } : {}),
    ...(config.onConflict !== undefined
      ? { onConflict: config.onConflict }
      : {}),

    authorizeUrl({ state, redirectUri }) {
      const url = new URL(STEAM_OPENID_ENDPOINT);
      url.searchParams.set("openid.ns", OPENID_NS);
      url.searchParams.set("openid.mode", "checkid_setup");
      url.searchParams.set(
        "openid.return_to",
        steamReturnTo(redirectUri, state),
      );
      url.searchParams.set("openid.realm", config.realm);
      url.searchParams.set("openid.claimed_id", OPENID_IDENTIFIER_SELECT);
      url.searchParams.set("openid.identity", OPENID_IDENTIFIER_SELECT);
      return url.toString();
    },

    async handleCallback({ query, redirectUri, fetchImpl }) {
      const doFetch = resolveFetch(fetchImpl);
      const mode = query["openid.mode"];

      // A player who backed out is `denied`, never `state_invalid` — the
      // latter reads as an attack in the failure event.
      if (mode === "cancel") {
        throw new AccountLinkCallbackError(
          "denied",
          "player cancelled the Steam sign-in",
        );
      }
      if (mode !== "id_res") {
        throw new AccountLinkCallbackError(
          "state_invalid",
          `unexpected openid.mode "${mode ?? "<absent>"}"`,
        );
      }

      // GUARD 1 — refuse an assertion that names a verifier other than Steam,
      // before anything at all happens. We never READ this field for routing
      // (see STEAM_OPENID_ENDPOINT); rejecting a mismatch just refuses to
      // process an assertion that was plainly not minted by the OP we trust.
      const opEndpoint = query["openid.op_endpoint"];
      if (opEndpoint !== undefined && opEndpoint !== STEAM_OPENID_ENDPOINT) {
        throw new AccountLinkCallbackError(
          "state_invalid",
          "openid.op_endpoint is not Steam's endpoint",
        );
      }

      // GUARD 2 — the channel binding. OpenID 2.0 has no `state`, so an
      // assertion minted for a different return_to is a cross-flow replay.
      // Byte-exact, state query parameter included.
      if (query["openid.return_to"] !== redirectUri) {
        throw new AccountLinkCallbackError(
          "state_invalid",
          "openid.return_to does not match the presented return_to",
        );
      }

      // GUARD 3 — parse before we touch the network, so a malformed id never
      // causes a request on its behalf.
      const steamId = parseSteamClaimedId(query["openid.claimed_id"] ?? "");
      if (!steamId) {
        throw new AccountLinkCallbackError(
          "state_invalid",
          "openid.claimed_id is not a steamcommunity.com steamid64 identifier",
        );
      }

      // The proof. Echo every openid.* param back with the mode rewritten, to
      // the HARDCODED endpoint. The callback's own parameters prove nothing on
      // their own — this round trip is the entire security of OpenID 2.0.
      const body = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (key.startsWith("openid.")) body.set(key, value);
      }
      body.set("openid.mode", "check_authentication");

      const response = await doFetch(STEAM_OPENID_ENDPOINT, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });
      if (!response.ok) {
        throw new AccountLinkCallbackError(
          "exchange_failed",
          endpointFailure(STEAM_OPENID_ENDPOINT, response.status),
        );
      }
      const text = await response.text();
      if (!/^is_valid:true$/m.test(text.trim())) {
        throw new AccountLinkCallbackError(
          "exchange_failed",
          "Steam did not confirm the assertion (is_valid was not true)",
        );
      }

      // Steam yields NO email and NO tokens, ever. Only the id is proof; the
      // rest is display data.
      return {
        providerUserId: steamId,
        ...(await fetchProfile(steamId, doFetch)),
      };
    },

    ...(config.webApiKey
      ? {
          sync: {
            every: hours(24),
            async read({
              providerUserId,
              fetchImpl,
            }: AccountSyncArgs): Promise<
              Record<string, string | number | boolean>
            > {
              const doFetch = resolveFetch(fetchImpl);
              const url = new URL(
                `${STEAM_API_BASE}/IPlayerService/GetRecentlyPlayedGames/v1/`,
              );
              url.searchParams.set("key", config.webApiKey as string);
              url.searchParams.set("steamid", providerUserId);
              const response = await doFetch(url.toString(), { method: "GET" });
              // A sync failure is not a link failure: return no scalars and
              // let the cron pick the row up on its next tick.
              if (!response.ok) return {};
              const json = (await readJson(response)) as
                | { response?: { games?: { playtime_2weeks?: number }[] } }
                | undefined;
              const games = json?.response?.games;
              if (!games?.length) return {};
              const minutes = games.reduce(
                (sum, game) => sum + (game.playtime_2weeks ?? 0),
                0,
              );
              // Namespaced scalar, so journeys and buckets read it off
              // `contacts.properties` with zero new machinery.
              return { steam_playtime_2wk: minutes };
            },
          },
        }
      : {}),
  });
}
