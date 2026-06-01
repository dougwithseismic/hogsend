import { backfillExampleTask } from "./backfill-example.js";

/**
 * Your custom Hatchet tasks, registered alongside the engine's built-in
 * workflows (send-email, import-contacts, check-alerts) via
 * `createWorker({ container, journeys, extraWorkflows })` in `src/worker.ts`.
 *
 * The engine registers its own workflows automatically — only list YOUR tasks
 * here, never the built-ins.
 *
 * `backfillExampleTask` is a ready-to-customize one-off backfill job. Remove it
 * (and `backfill-example.ts`) if you don't need it yet.
 */
export const extraWorkflows = [backfillExampleTask];
