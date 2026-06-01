import { createHogsendClient, createWorker } from "@hogsend/engine";
import { templates } from "./emails/index.js";
import { journeys } from "./journeys/index.js";

async function main() {
  const client = createHogsendClient({ journeys, email: { templates } });
  const worker = createWorker({ container: client, journeys });

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
