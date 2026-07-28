/**
 * cloud-worker entry point. Run with `pnpm --filter @hogsend/cloud worker`.
 *
 * Everything with behaviour lives in `worker-runtime.ts`; this file owns only
 * the two process-level concerns: reading validated env, and translating
 * SIGTERM/SIGINT into one graceful stop.
 */
import { env } from "./env";
import {
  getCloudHatchet,
  getProvisionStackTask,
  PROVISION_STACK_TASK,
} from "./pipeline/hatchet";
import { startWorker } from "./worker-runtime";

const worker = startWorker({
  databaseUrl: env.CLOUD_DATABASE_URL,
  nodeEnv: env.NODE_ENV,
  hatchetConfigured: Boolean(env.CLOUD_HATCHET_CLIENT_TOKEN),
  substrate: env.CLOUD_SUBSTRATE,
  // Built here rather than inside the runtime so the runtime stays a plain
  // function over injected config — the Hatchet client is the one dependency
  // that opens a socket at construction.
  startHatchetWorker: async () => {
    const client = getCloudHatchet();
    if (!client) throw new Error("no cloud Hatchet client");
    const hatchetWorker = await client.worker("cloud-worker", {
      workflows: [getProvisionStackTask(client)],
    });
    // `start()` does not resolve until the worker stops — awaiting it here
    // would hang boot. Kick it off and hand back the handle.
    void hatchetWorker.start().catch((error: unknown) => {
      process.stderr.write(
        `${JSON.stringify({
          service: "cloud-worker",
          event: "tasks",
          error: error instanceof Error ? error.message : String(error),
        })}\n`,
      );
    });
    return hatchetWorker;
  },
});

process.stdout.write(
  `${JSON.stringify({
    service: "cloud-worker",
    event: "config",
    substrate: env.CLOUD_SUBSTRATE,
    task: PROVISION_STACK_TASK,
  })}\n`,
);

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  // A second Ctrl-C while draining must not start a second shutdown.
  if (shuttingDown) return;
  shuttingDown = true;
  process.stdout.write(
    `${JSON.stringify({ service: "cloud-worker", event: "signal", signal })}\n`,
  );
  await worker.stop();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
