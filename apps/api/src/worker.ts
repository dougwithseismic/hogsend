import { hatchet } from "./lib/hatchet.js";
import { runJourneyTask, sendEmailTask } from "./workflows/index.js";

async function main() {
  const worker = await hatchet.worker("hogsend-worker", {
    workflows: [sendEmailTask, runJourneyTask],
  });

  console.log("Hogsend worker started, waiting for workflow runs...");
  await worker.start();
}

main().catch((err) => {
  console.error("Worker failed to start:", err);
  process.exit(1);
});
