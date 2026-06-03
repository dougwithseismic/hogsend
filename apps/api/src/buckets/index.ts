import type { DefinedBucket } from "@hogsend/engine";
import { powerUsers } from "./power-users.js";
import { trialExpiringSoon } from "./trial-expiring-soon.js";
import { wentDormant } from "./went-dormant.js";

/**
 * All defined buckets for this app. Passed to `createHogsendClient({ buckets })`
 * and `createWorker({ buckets })`. Edit freely — this is your content.
 *
 * The `BucketId` union in `journeys/constants/buckets.ts` is derived from this
 * array (`(typeof buckets)[number]["meta"]["id"]`), so adding a bucket here keeps
 * the typed `bucketEntered`/`bucketLeft` alias helpers in sync automatically.
 */
export const buckets: DefinedBucket[] = [
  powerUsers,
  trialExpiringSoon,
  wentDormant,
];

// Re-export individual buckets for direct reference (tests, custom wiring).
export { powerUsers, trialExpiringSoon, wentDormant };
