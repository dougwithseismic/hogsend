import { powerUsers } from "./power-users.js";
import { trialExpiringSoon } from "./trial-expiring-soon.js";
import { wentDormant } from "./went-dormant.js";

/**
 * All defined buckets for this app. Passed to `createHogsendClient({ buckets })`
 * and `createWorker({ buckets })`. Edit freely — this is your content.
 *
 * No `DefinedBucket[]` annotation: that base type re-widens each bucket's `id`
 * literal back to `string` and erases the typed `bucket.entered` / `bucket.left`
 * refs. Letting the array infer keeps every member's literal id, so
 * `wentDormant.left` stays `"bucket:left:went-dormant"`. A `DefinedBucket<Id>` is
 * still assignable to the base `DefinedBucket[]` that the factories accept.
 */
export const buckets = [powerUsers, trialExpiringSoon, wentDormant];

// Re-export individual buckets for direct reference (tests, custom wiring).
export { powerUsers, trialExpiringSoon, wentDormant };
