import type { DefinedBucket } from "@hogsend/engine";
import { powerUsers } from "./power-users.js";

/**
 * All defined buckets for this app. Passed to `createHogsendClient({ buckets })`
 * and `createWorker({ buckets })`. Edit freely — this is your content.
 *
 * Keep the `BucketId` union in `journeys/constants/index.ts` in sync with the ids
 * registered here — that union is what makes the typed `bucketEntered`/
 * `bucketLeft` alias helpers catch a typo'd binding at compile time.
 */
export const buckets: DefinedBucket[] = [powerUsers];

// Re-export individual buckets for direct reference (tests, custom wiring).
export { powerUsers };
