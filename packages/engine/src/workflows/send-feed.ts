import type { JsonValue } from "@hatchet-dev/typescript-sdk/v1/types.js";
import type { FeedBlock } from "@hogsend/db";
import { type SendFeedItemOptions, sendFeedItem } from "../lib/feed.js";
import { hatchet } from "../lib/hatchet.js";

/**
 * JSON-serializable input for the `send-feed` task. Mirrors the journey task
 * convention (explicit fields + a `[key: string]: JsonValue` index signature) so
 * Hatchet's `JsonObject` constraint is satisfied; the fn re-narrows it to the
 * structured {@link SendFeedItemOptions} at the boundary.
 */
interface SendFeedTaskInput {
  recipient: { userId?: string; email?: string; anonymousId?: string };
  type: string;
  title?: string;
  body?: string;
  blocks?: FeedBlock[];
  actionUrl?: string;
  metadata?: Record<string, JsonValue>;
  category?: string;
  templateKey?: string;
  journeyStateId?: string;
  idempotencyKey?: string;
  [key: string]: JsonValue | undefined;
}

/**
 * Durable wrapper around {@link sendFeedItem} — the in-app-feed sibling of the
 * `send-email` task. `sendFeedItem` owns recipient resolution, `in_app`
 * suppression, the replay-safe idempotency key, and the Redis publish.
 */
export const sendFeedTask = hatchet.task({
  name: "send-feed",
  retries: 1,
  executionTimeout: "30s",
  backoff: { factor: 2, maxSeconds: 30 },
  fn: async (input: SendFeedTaskInput) => {
    const result = await sendFeedItem(input as SendFeedItemOptions);
    return {
      feedItemId: result.feedItemId,
      suppressed: result.suppressed,
    };
  },
});
