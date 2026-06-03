import type { BucketMeta } from "@hogsend/core";
import type { Logger } from "./logger.js";
import { getPostHog } from "./posthog.js";

/**
 * Optional PostHog person-property mirror for a bucket transition (Section 12).
 *
 * OFF BY DEFAULT — a no-op unless `meta.syncToPostHog === true`. Also a no-op
 * without `POSTHOG_API_KEY` (`getPostHog()` returns undefined), so self-host
 * setups that omit PostHog silently do nothing — documented, not broken.
 *
 * On JOIN it `$set`s a boolean person property `true`; on LEAVE it `$unset`s the
 * same key. `$unset` (NOT `$set false`) is the recommended default: a cohort
 * `key = true` excludes a false value, but a cohort `key is set` STILL matches a
 * false value, so `$unset` is the only form where both cohort idioms behave
 * correctly. The property key defaults to `hogsend_bucket_<id>`, overridable via
 * `meta.postHogPropertyKey`.
 *
 * This reuses the existing `plugin-posthog` capture path (the same one
 * `identify()` uses at journey-context.ts) — it adds no new integration surface
 * and never pushes to any non-PostHog destination (the Section 2.4 anti-CDP
 * invariant). Best-effort: a capture failure is logged and swallowed so a sync
 * error never blocks a transition emit.
 */
export function syncBucketToPostHog(opts: {
  logger: Logger;
  kind: "entered" | "left";
  bucket: BucketMeta;
  userId: string;
}): void {
  const { logger, kind, bucket, userId } = opts;

  if (!bucket.syncToPostHog) return;

  const posthog = getPostHog();
  if (!posthog) return; // no POSTHOG_API_KEY → silent no-op

  const propertyKey =
    bucket.postHogPropertyKey ?? `hogsend_bucket_${bucket.id}`;

  try {
    if (kind === "entered") {
      // $set { key: true } — mirrors plugin-posthog identify() ($set path).
      posthog.identify(userId, { [propertyKey]: true });
    } else {
      // $unset [key] — RECOMMENDED on leave (Section 12). The property is absent
      // unless the user is currently a member, so both `key = true` and
      // `key is set` cohorts behave correctly.
      posthog.captureEvent({
        distinctId: userId,
        event: "$set",
        properties: { $unset: [propertyKey] },
      });
    }
  } catch (err) {
    logger.warn("Bucket PostHog sync failed (best-effort)", {
      bucketId: bucket.id,
      userId,
      kind,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
