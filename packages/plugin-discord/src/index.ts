/**
 * `@hogsend/plugin-discord` engine-facing surface — the INBOUND connector + its
 * connect-time factory, the OUTBOUND destination, and the `fetch`/`node:crypto`
 * connect helpers. ZERO `discord.js`: everything here runs inside the engine API
 * process. The long-lived Gateway worker is exported ONLY from the
 * `"@hogsend/plugin-discord/gateway"` subpath.
 */

export {
  handleInteraction,
  type InteractionResponse,
  InteractionResponseType,
  InteractionType,
  verifyInteractionSignature,
} from "./connect/interactions.js";
export {
  type DiscordMemberLink,
  type MemberLinkContactPatch,
  memberLinkToContactPatch,
} from "./connect/member-link.js";
export {
  buildBotInstallUrl,
  buildMemberLinkUrl,
  type DiscordCurrentUser,
  type DiscordTokenResponse,
  exchangeDiscordCode,
  getCurrentUser,
} from "./connect/oauth.js";
export {
  type PatchApplicationArgs,
  type PatchApplicationResult,
  patchApplication,
} from "./connect/patch-application.js";
export {
  type CreateDiscordConnectorConfig,
  createDiscordConnector,
  type DiscordConnectorWithHandlers,
  /**
   * The bare `discordConnector` is TRANSFORM-ONLY — it has NO `handlers`, so
   * the generic oauth/interactions routes cannot dispatch into it (a bare
   * registration warns + 404s). Register {@link createDiscordConnector}(config)
   * — the connect-ready clone with `handlers` populated — to serve the connect
   * flow. The bare const is exported only for the gateway worker's transform.
   */
  discordConnector,
} from "./connector.js";
export {
  DISCORD_API_BASE,
  DISCORD_BOT_INSTALL_SCOPES,
  DISCORD_INTENTS,
  DISCORD_MEMBER_LINK_SCOPES,
  DISCORD_PROVIDER_ID,
} from "./constants.js";
export { discordDestination } from "./destination.js";
export type { DiscordEnv } from "./env.js";
export {
  type DiscordDispatchType,
  type DiscordEventName,
  DiscordEvents,
} from "./events.js";
