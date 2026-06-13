import { startDiscordGatewayHeartbeat } from "@hogsend/engine";
import { createDiscordGatewayWorker } from "@hogsend/plugin-discord/gateway";
import { discordEnv } from "./env.js";

/**
 * The standalone Discord Gateway worker — its OWN long-lived process (NOT the
 * Hatchet worker, NOT the API). It holds a `discord.js` socket and forwards
 * every relevant raw dispatch to `${API_PUBLIC_URL}/v1/connectors/discord/ingress`
 * behind `x-hogsend-ingress-secret`, where the connector's transform turns it
 * into an IngestEvent. `discord.js` is a runtime dependency of apps/api precisely
 * because THIS process resolves the gateway worker's dynamic import.
 *
 * Boot requirements (fail loudly if missing): `DISCORD_BOT_TOKEN` (Gateway
 * login — the three privileged intents must be toggled ON in the Developer
 * Portal or `login()` rejects), and `CONNECTOR_INGRESS_SECRET` (≥32 chars; the
 * ingress route fail-closes without it, so a worker that forwards into an
 * unconfigured route would 401 every event).
 */
async function main() {
  const botToken = discordEnv.DISCORD_BOT_TOKEN;
  const ingressSecret = discordEnv.CONNECTOR_INGRESS_SECRET;

  if (!botToken) {
    throw new Error(
      "DISCORD_BOT_TOKEN is required to start the Discord gateway worker",
    );
  }
  if (!ingressSecret) {
    throw new Error(
      "CONNECTOR_INGRESS_SECRET (>=32 chars) is required — the connector " +
        "ingress route fail-closes without it, so the worker cannot forward",
    );
  }

  // Publish gateway-worker liveness on a TTL'd Redis key so Studio's
  // `/integrations` card can show "Worker Online" + a confirmed "Bot installed"
  // (from the observed guild) for env-only deploys. Best-effort — a Redis-less
  // deploy simply reads back as "Offline" and never crashes the worker.
  const logger = {
    debug: (msg: string, meta?: unknown) => console.debug(msg, meta),
  };
  const heartbeat = startDiscordGatewayHeartbeat(logger as never);

  const worker = createDiscordGatewayWorker({
    botToken,
    apiPublicUrl: discordEnv.API_PUBLIC_URL,
    ingressSecret,
    // intents default to the privileged trio + base inside the worker.
    onGuildObserved: (gid) => heartbeat.state.setGuildId(gid),
  });

  async function shutdown(signal: string) {
    console.log(`${signal} received, stopping Discord gateway worker`);
    // Delete the heartbeat key FIRST → the card flips to "Offline" immediately
    // rather than waiting out the TTL.
    await heartbeat.stop();
    await worker.stop();
    console.log("Discord gateway worker stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
}

main().catch((err) => {
  console.error("Discord gateway worker failed to start:", err);
  process.exit(1);
});
