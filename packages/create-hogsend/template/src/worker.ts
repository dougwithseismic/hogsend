import { createHogsendClient, createWorker } from "@hogsend/engine";
import { buckets } from "./buckets/index.js";
import { campaigns } from "./campaigns/index.js";
import { destinations } from "./destinations/index.js";
import { templates } from "./emails/index.js";
import { flags } from "./flags/index.js";
import { Events, Templates } from "./journeys/constants/index.js";
import { journeys } from "./journeys/index.js";
import { lists } from "./lists/index.js";
import { extraWorkflows } from "./workflows/index.js";

async function main() {
  const client = createHogsendClient({
    journeys,
    buckets,
    lists,
    campaigns,
    destinations,
    // Mirror the API's flag registration (registry-mirror rule) so BOTH
    // processes reconcile the code-defined flags into `flags` rows at boot.
    flags,
    email: { templates },
    // Feeds the Studio journey-graph route your `Templates`/`Events` `as const`
    // maps so `Templates.X`/`Events.X` in journey source resolve to real values —
    // exact email previews and stable, join-safe node ids.
    journeyConstants: { templates: Templates, events: Events },
  });
  const worker = createWorker({
    container: client,
    journeys,
    buckets,
    // Your custom Hatchet tasks (see src/workflows/index.ts). The engine's
    // built-in workflows are registered automatically — list only your own.
    extraWorkflows,
  });

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
