/**
 * cloud-worker entry point. Run with `pnpm --filter @hogsend/cloud worker`.
 *
 * Everything with behaviour lives in `worker-runtime.ts`; this file owns only
 * the two process-level concerns: reading validated env, and translating
 * SIGTERM/SIGINT into one graceful stop.
 */
import { env } from "./env";
import { startWorker } from "./worker-runtime";

const worker = startWorker({
  databaseUrl: env.CLOUD_DATABASE_URL,
  nodeEnv: env.NODE_ENV,
});

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
