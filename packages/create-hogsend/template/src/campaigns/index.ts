import { powerUsersPreview } from "./power-users-preview.js";
import { productLaunch } from "./product-launch.js";

/**
 * Code-defined campaigns (broadcasts) — one-shot scheduled sends committed to
 * the repo. Write a file, deploy, and the worker's boot reconciler schedules
 * it; once sent it is retired (redeploys no-op, keyed by the campaign `id`).
 *
 * The two examples ship `enabled: false` so a fresh deploy never sends them —
 * write your copy, set a real future `sendAt`, flip `enabled`, deploy. Rules
 * the reconciler enforces:
 *
 *  - a future `sendAt` is scheduled and delivered at that instant
 *  - editing a file before the send updates the pending broadcast
 *    (moving `sendAt` re-schedules)
 *  - a `sendAt` already stale at FIRST deploy (past the 1h grace,
 *    `CAMPAIGN_DEFINE_GRACE_MS`) is marked `expired`, never sent — a late
 *    deploy can't fire a surprise blast
 *  - once sent, the campaign is retired; a canceled one stays canceled
 *
 * Cancel a pending campaign with `hogsend campaigns cancel <id>` or from
 * Studio. Passed to `createHogsendClient({ campaigns })` in `src/index.ts` and
 * `src/worker.ts` (the worker reconciles at boot).
 */
export const campaigns = [productLaunch, powerUsersPreview];

// Re-export individual campaigns for direct reference (tests, custom wiring).
export { powerUsersPreview, productLaunch };
