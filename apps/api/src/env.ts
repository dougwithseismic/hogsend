import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Consumer-owned env for the Discord connector + gateway worker. The engine owns
 * `API_PUBLIC_URL` + `CONNECTOR_INGRESS_SECRET` (validated in
 * `@hogsend/engine`'s `env.ts`); the `DISCORD_*` vars are the consumer's, so we
 * validate them here. The plugin itself never reads `process.env` — these values
 * are injected explicitly into `createDiscordConnector` / the gateway worker.
 *
 * Every Discord var is OPTIONAL so a deploy with NO Discord configured still
 * boots (the connector/worker simply have nothing to act on). The
 * connect-via-CLI flow can ALSO persist these into the derived credential
 * (`provider_credentials`, kind="derived"); this env block is the deploy-time
 * mirror the standalone gateway worker reads at boot to avoid a DB round-trip.
 */
export const discordEnv = createEnv({
  server: {
    /** Bot token — Gateway login + bot-REST. */
    DISCORD_BOT_TOKEN: z.string().min(1).optional(),
    /** OAuth2 application (client) id — bot-install + member-link URLs. */
    DISCORD_APPLICATION_ID: z.string().min(1).optional(),
    /** OAuth2 client secret — server-side code exchange only. */
    DISCORD_CLIENT_SECRET: z.string().min(1).optional(),
    /** Ed25519 public key (hex) — interaction signature verification. */
    DISCORD_PUBLIC_KEY: z.string().min(1).optional(),
    /** Default guild id (populated after the bot is installed). */
    DISCORD_GUILD_ID: z.string().min(1).optional(),
    /**
     * Public base URL — the connect redirect/interactions URLs and the gateway
     * worker's ingress target derive from it. Mirrors the engine's
     * `API_PUBLIC_URL` (same default) so the consumer can read it without the
     * container.
     */
    API_PUBLIC_URL: z.string().url().default("http://localhost:3002"),
    /**
     * Shared secret for the gateway-worker → connector ingress hop. Mirrors the
     * engine's `CONNECTOR_INGRESS_SECRET` (≥32 chars, fail-closed when unset).
     */
    CONNECTOR_INGRESS_SECRET: z.string().min(32).optional(),
  },
  runtimeEnv: process.env,
  emptyStringAsUndefined: true,
});
