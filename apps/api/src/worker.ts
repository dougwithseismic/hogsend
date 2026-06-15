import { createHogsendClient, createWorker } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import {
  buildDiscordConnector,
  discordDestination,
  setDiscordDb,
} from "./discord.js";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { lists } from "./lists/index.js";

async function main() {
  const discordConnector = buildDiscordConnector();

  const client = createHogsendClient({
    journeys,
    buckets,
    lists,
    email: { templates },
    // Mirror the API's connector/destination registration so the worker's
    // process-singleton registries match (the ingest pipeline runs here too).
    connectors: discordConnector ? [discordConnector] : [],
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
