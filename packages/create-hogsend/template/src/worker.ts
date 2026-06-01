import { createHogsendClient, createWorker } from "@hogsend/engine";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";
import { extraWorkflows } from "./workflows/index.js";

async function main() {
  const client = createHogsendClient({ journeys, email: { templates } });
  const worker = createWorker({
    container: client,
    journeys,
    // Your custom Hatchet tasks (see src/workflows/index.ts). The engine's
    // built-in workflows are registered automatically — list only your own.
    extraWorkflows,
  });

  async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down worker`);
    await worker.stop();
    console.log("Worker stopped");
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
