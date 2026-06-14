/**
 * The Discord env contract the CONSUMER validates (the engine's `env.ts` owns
 * `CONNECTOR_INGRESS_SECRET` + `API_PUBLIC_URL`; Discord-specific vars are the
 * consumer's). This is documentation-as-types: the plugin never reads
 * `process.env` itself — the connect helpers receive values explicitly so the
 * package stays env-source-agnostic. The consumer wires these into its own
 * `@t3-oss/env-core` schema.
 *
 * App secrets ALSO live encrypted in `provider_credentials` (kind="derived",
 * providerId="discord") after `hogsend connect discord` — `DiscordEnv` is the
 * deploy-time mirror the gateway worker reads to avoid a DB round-trip at boot.
 * Rotation must update BOTH (see the plugin README rotation runbook).
 */
export interface DiscordEnv {
  /** Bot token (`Bot <token>` for REST + the Gateway login). */
  DISCORD_BOT_TOKEN?: string;
  /** OAuth2 application (client) id — bot-install + member-link links. */
  DISCORD_APPLICATION_ID?: string;
  /** OAuth2 client secret — server-side code exchange only, never shipped. */
  DISCORD_CLIENT_SECRET?: string;
  /** Ed25519 public key (hex) — interactions signature verification. */
  DISCORD_PUBLIC_KEY?: string;
  /** Default guild id the bot is installed into (populated after install). */
  DISCORD_GUILD_ID?: string;
}
