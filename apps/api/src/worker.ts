import { createJourneyRegistry, getJourneyTasks } from "./journeys/index.js";
import { hatchet } from "./lib/hatchet.js";
import { getPostHog } from "./lib/posthog.js";
import { getRedisIfConnected } from "./lib/redis.js";
import { checkAlertsTask } from "./workflows/check-alerts.js";
import { importContactsTask } from "./workflows/import-contacts.js";
import { sendEmailTask } from "./workflows/send-email.js";

async function main() {
  createJourneyRegistry(process.env.ENABLED_JOURNEYS);
  const journeyTasks = getJourneyTasks(process.env.ENABLED_JOURNEYS);

  const worker = await hatchet.worker("hogsend-worker", {
    workflows: [
      sendEmailTask,
      importContactsTask,
      checkAlertsTask,
      ...journeyTasks,
    ],
  });

  console.log(
    `Hogsend worker started with ${journeyTasks.length} journey task(s)`,
  );

  async function shutdown(signal: string) {
    console.log(`${signal} received, shutting down worker`);
    await Promise.allSettled([
      worker.stop(),
      getPostHog()?.shutdown(),
      getRedisIfConnected()?.quit(),
    ]);
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
