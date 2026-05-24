import { getJourneyTasks } from "./journeys/index.js";
import { hatchet } from "./lib/hatchet.js";
import { sendEmailTask } from "./workflows/send-email.js";

async function main() {
  const journeyTasks = getJourneyTasks(process.env.ENABLED_JOURNEYS);

  const worker = await hatchet.worker("hogsend-worker", {
    workflows: [sendEmailTask, ...journeyTasks],
  });

  console.log(
    `Hogsend worker started with ${journeyTasks.length} journey task(s)`,
  );
  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
