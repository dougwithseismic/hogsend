import { createHogsendClient, createWorker } from "@hogsend/engine";
import { discordActions } from "@hogsend/plugin-discord";
import { telegramActions, telegramConnector } from "@hogsend/plugin-telegram";
import { buckets } from "./buckets/index.js";
import { conversions } from "./conversions/index.js";
import {
  buildDiscordConnector,
  discordDestination,
  setDiscordDb,
} from "./discord.js";
import { templates } from "./emails/index.js";
import { funnels } from "./funnels.js";
import { Events, Templates } from "./journeys/constants/index.js";
import { journeys } from "./journeys/index.js";
import { lists } from "./lists/index.js";
import { smsTemplates } from "./sms/index.js";
import { surfaces } from "./surfaces.js";

async function main() {
  const discordConnector = buildDiscordConnector();

  const client = createHogsendClient({
    journeys,
    conversions,
    buckets,
    lists,
    // Mirror the API's funnel registration (registry-mirror rule) so webhook
    // and reconcile-poll paths stamp the same funnel ids.
    funnels,
    // Mirror the API's surfaces (registry-mirror rule) so the worker's
    // flow-topology singleton classifies the same nodes on the ingest path.
    surfaces,
    email: { templates },
    // Mirror the API's journeyConstants (registry-mirror rule) so both client
    // configs stay in parity — resolves `Templates.X`/`Events.X` in the Studio
    // journey graph (route runs in the API, but configs are kept identical).
    journeyConstants: { templates: Templates, events: Events },
    // SMS templates must mirror the API (same registry rule as email) so the
    // worker's tracked SMS sender resolves the same keys journeys send.
    sms: { templates: smsTemplates },
    // Mirror the API's connector/destination registration so the worker's
    // process-singleton registries match (the ingest pipeline runs here too).
    connectors: [
      ...(discordConnector ? [discordConnector] : []),
      telegramConnector,
    ],
    connectorActions: [
      ...telegramActions,
      ...(discordConnector ? discordActions : []),
    ],
    destinations: [discordDestination],
  });
  setDiscordDb(client.db, client.identity);
  const worker = createWorker({ container: client, journeys, buckets });

  async function shutdown(signal: string) {
    client.logger.info(`${signal} received, shutting down worker`);
    await worker.stop();
    client.logger.info("Worker stopped");
    process.exit(0);
  }

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
