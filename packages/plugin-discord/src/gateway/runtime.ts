import type { ConnectorRuntime, ConnectorRuntimeDeps } from "@hogsend/engine";
import { createDiscordGatewayWorker } from "./worker.js";

/**
 * The Discord {@link ConnectorRuntime} factory — the plugin's contribution to
 * the engine's connector-runtime seam. The consumer passes it to
 * `createWorker({ connectorRuntimes: { discord: createDiscordRuntime } })`; the
 * engine elects a single leader replica and calls this with an in-process
 * `ingest` sink, so the gateway socket forwards dispatches straight into
 * `transform`→`ingestEvent` — no HTTP ingress hop, no `CONNECTOR_INGRESS_SECRET`.
 *
 * Returns `null` when `DISCORD_BOT_TOKEN` is unset — the engine then skips
 * Discord cleanly (no lease held, dashboard stays truthfully Offline). The bot
 * token is the platform's OWN env, read here (not in the engine) so the engine
 * stays platform-neutral; `discord.js` is still imported only inside the worker's
 * `start()` (dynamic import), so enabling the runtime without the optional peer
 * fails loudly at start rather than at module load.
 */
export function createDiscordRuntime(
  deps: ConnectorRuntimeDeps,
): ConnectorRuntime | null {
  const botToken = process.env.DISCORD_BOT_TOKEN;
  if (!botToken) {
    deps.logger.info(
      "Discord runtime: DISCORD_BOT_TOKEN not set; gateway will not start",
    );
    return null;
  }

  const worker = createDiscordGatewayWorker({
    botToken,
    // Unused in inline mode — the poster below replaces the HTTP ingress hop.
    apiPublicUrl: "",
    ingressSecret: "",
    poster: async ({ dispatchType, data }) => deps.ingest(dispatchType, data),
    // Fold the guild id (seen at GUILD_CREATE) into the engine heartbeat so
    // Studio confirms "Bot installed".
    onGuildObserved: (guildId) => deps.onMetadata({ guildId }),
  });

  return {
    start: () => worker.start(),
    stop: () => worker.stop(),
    getMetadata: () => ({ intents: worker.getIntents() }),
  };
}
