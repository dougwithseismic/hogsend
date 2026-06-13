import {
  DISCORD_API_BASE,
  DISCORD_BOT_INSTALL_SCOPES,
  DISCORD_MEMBER_LINK_SCOPES,
  DISCORD_OAUTH_AUTHORIZE_URL,
  DISCORD_OAUTH_TOKEN_URL,
} from "../constants.js";

/**
 * Discord OAuth2 URL builders + the authorization-code exchange. `fetch`-only;
 * zero `discord.js`. These run inside the engine API process (the connect flow
 * + the connector's `oauthCallback` handler).
 *
 * SECURITY — both authorize-URL builders REQUIRE a `state`: the redirect lands
 * UNAUTHENTICATED on `/v1/connectors/discord/oauth/callback`, so without a
 * caller-minted, server-verified `state` an attacker could forge the callback
 * (login-CSRF / grafting a Discord id onto an arbitrary contact). For the
 * member-link flow the `state` MUST also bind the intended contact/email; the
 * `oauthCallback` handler verifies `state` BEFORE exchanging the code.
 */

export interface BuildBotInstallUrlArgs {
  applicationId: string;
  /** Redirect URI registered on the app (…/v1/connectors/discord/oauth/callback). */
  redirectUri: string;
  /** Permissions bitfield the bot is requested with (stringified integer). */
  permissions: string;
  /** Opaque CSRF state the callback verifies. */
  state: string;
  /** Optional guild to pre-select in the install dialog. */
  guildId?: string;
}

/**
 * The one-click bot-install authorize URL. `flow=install` is appended to the
 * redirect URI so the single `oauthCallback` can branch install vs. member.
 */
export function buildBotInstallUrl(args: BuildBotInstallUrlArgs): string {
  const redirect = new URL(args.redirectUri);
  redirect.searchParams.set("flow", "install");

  const url = new URL(DISCORD_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", args.applicationId);
  url.searchParams.set("scope", DISCORD_BOT_INSTALL_SCOPES.join(" "));
  url.searchParams.set("permissions", args.permissions);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect.toString());
  url.searchParams.set("state", args.state);
  if (args.guildId) {
    url.searchParams.set("guild_id", args.guildId);
    url.searchParams.set("disable_guild_select", "true");
  }
  return url.toString();
}

export interface BuildMemberLinkUrlArgs {
  applicationId: string;
  redirectUri: string;
  /** Opaque CSRF state — MUST bind the intended contact/email (see header). */
  state: string;
}

/**
 * The per-member link authorize URL. `flow=member` is appended to the redirect
 * URI so the single `oauthCallback` can branch install vs. member.
 */
export function buildMemberLinkUrl(args: BuildMemberLinkUrlArgs): string {
  const redirect = new URL(args.redirectUri);
  redirect.searchParams.set("flow", "member");

  const url = new URL(DISCORD_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", args.applicationId);
  url.searchParams.set("scope", DISCORD_MEMBER_LINK_SCOPES.join(" "));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirect.toString());
  url.searchParams.set("state", args.state);
  url.searchParams.set("prompt", "consent");
  return url.toString();
}

/** Discord's token-endpoint response (subset; bot-install adds `guild`). */
export interface DiscordTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  /** Present on a bot-install grant — the guild the bot was added to. */
  guild?: { id: string; name?: string };
}

export interface ExchangeDiscordCodeArgs {
  applicationId: string;
  clientSecret: string;
  code: string;
  /** MUST byte-match the `redirect_uri` sent on the authorize URL (incl. flow). */
  redirectUri: string;
}

/**
 * Exchange an authorization `code` for tokens at Discord's token endpoint.
 * `application/x-www-form-urlencoded`, HTTP-Basic-free (client id + secret in
 * the body, per Discord's docs). Throws on a non-2xx.
 *
 * SECRET HYGIENE — the thrown message carries ONLY the HTTP status + a short
 * static reason. Discord's error body can echo the request (which contains the
 * `client_secret`) or partial token material, so it is NEVER interpolated into
 * the thrown message or logged.
 */
export async function exchangeDiscordCode(
  args: ExchangeDiscordCodeArgs,
): Promise<DiscordTokenResponse> {
  const body = new URLSearchParams({
    client_id: args.applicationId,
    client_secret: args.clientSecret,
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
  });

  const res = await fetch(DISCORD_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!res.ok) {
    throw new Error(`Discord token exchange failed (${res.status})`);
  }
  return (await res.json()) as DiscordTokenResponse;
}

/** Discord `/users/@me` response subset — the member-link identity pull. */
export interface DiscordCurrentUser {
  id: string;
  username?: string;
  /** Discord's display name (the post-2023 unique-name system). */
  global_name?: string | null;
  /** Avatar hash (NOT a URL). */
  avatar?: string | null;
  email?: string | null;
  /** TRUE iff Discord has verified the email — gate the link on this. */
  verified?: boolean;
}

/**
 * Fetch the authenticated user (member-link flow). Throws on a non-2xx with
 * ONLY the HTTP status — the response/error body (and the Bearer token it
 * pertains to) is never echoed into the thrown message or logged.
 */
export async function getCurrentUser(
  accessToken: string,
): Promise<DiscordCurrentUser> {
  const res = await fetch(`${DISCORD_API_BASE}/users/@me`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`Discord /users/@me failed (${res.status})`);
  }
  return (await res.json()) as DiscordCurrentUser;
}
