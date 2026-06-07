import type { HatchetClient } from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { BucketMeta } from "@hogsend/core";
import type { JourneyRegistry } from "@hogsend/core/registry";
import type { Database } from "@hogsend/db";
import type { BucketLeaveReason } from "../buckets/bucket-reactions.js";
import { syncBucketToPostHog } from "./bucket-posthog-sync.js";
import { ingestEvent } from "./ingestion.js";
import type { Logger } from "./logger.js";

export type BucketTransitionKind = "entered" | "left" | "dwell";

/** Where a transition originated — carried on the emitted event properties. */
export type BucketTransitionSource =
  | "event"
  | "reconcile"
  | "backfill"
  | "manual";

/**
 * Emit a bucket transition back through `ingestEvent` (the `ctx.trigger`
 * precedent) — shared by ALL three producers (real-time `checkBucketMembership`,
 * the reconcile cron, and the fast-expiry timer) so they compute byte-identical
 * `idempotencyKey`s for the same transition and converge to ONE emission
 * (Section 6.3 worked example).
 *
 * Persists to `userEvents`, pushes to Hatchet (routing to journeys), and runs
 * `checkExits`. Emits the per-bucket ALIAS (`bucket:<kind>:<id>`) by default; the
 * generic `bucket:<kind>` is emitted ONLY when a generic-bound journey actually
 * exists (aliased-only default — Section 8.5). `epoch` is the winning membership
 * row's `entryCount`, read off the single winning mutation by the caller.
 */
export async function emitBucketTransition(opts: {
  db: Database;
  /** The JOURNEY registry — forwarded into the recursive emit ingestEvent. */
  registry: JourneyRegistry;
  hatchet: HatchetClient;
  logger: Logger;
  kind: BucketTransitionKind;
  bucket: BucketMeta;
  userId: string;
  userEmail: string | null;
  epoch: number;
  source?: BucketTransitionSource;
  /** Carried on a `left` transition's properties → `ctx.reason`. */
  reason?: BucketLeaveReason;
  /** The dwell schedule label (`after-<ms>`/`every-<ms>`) — `dwell` only. */
  dwellLabel?: string;
  /**
   * The deterministic dwell interval ordinal — `dwell` only. Rides the
   * idempotencyKey so a same-sweep retry recomputes the identical key and is
   * absorbed by the `userEvents` dedup. Surfaced as `dwellCount`.
   */
  dwellOrdinal?: number;
}): Promise<void> {
  const {
    db,
    registry,
    hatchet,
    logger,
    kind,
    bucket,
    userId,
    userEmail,
    epoch,
    source = "event",
    reason,
    dwellLabel,
    dwellOrdinal,
  } = opts;

  // The dwell transition emits a labelled event so two dwell reactions on one
  // bucket (one `after`, one `every`) route distinctly; enter/left keep the
  // canonical `bucket:<kind>:<id>` form. The idempotencyKey is recomputed
  // identically by a retry: enter/left key on the membership epoch, dwell keys
  // on the (label, ordinal) so a same-sweep retry rides the userEvents dedup.
  const eventName =
    kind === "dwell"
      ? `bucket:dwell:${bucket.id}:${dwellLabel}`
      : `bucket:${kind}:${bucket.id}`;
  const idempotencyKey =
    kind === "dwell"
      ? `bucket:${bucket.id}:${userId}:dwell:${dwellLabel}:${dwellOrdinal}`
      : `bucket:${bucket.id}:${userId}:${kind}:${epoch}`;

  const properties: Record<string, unknown> = {
    bucketId: bucket.id,
    bucketName: bucket.name,
    userId,
    transition: kind,
    source,
    // entryCount is always carried (the membership ordinal); the reaction `run`
    // derives `isFirstEntry` from it.
    entryCount: epoch,
  };
  // reason is carried on a leave so the `leave` reaction can filter on it.
  if (kind === "left" && reason != null) {
    properties.reason = reason;
  }
  // dwellCount = the interval ordinal, surfaced to the dwell reaction.
  if (kind === "dwell" && dwellOrdinal != null) {
    properties.dwellCount = dwellOrdinal;
  }

  // Optional PostHog person-property mirror (Section 12). Off by default; a
  // no-op without POSTHOG_API_KEY. Wired here, the single transition path shared
  // by all three producers (real-time / reconcile / fast-expiry), so the sync
  // fires exactly once per emitted transition. Best-effort — it never blocks the
  // event emit below. Dwell is a recurring membership-age tick, not a state
  // change, so it does NOT mirror a person property.
  if (kind === "entered" || kind === "left") {
    syncBucketToPostHog({ logger, kind, bucket, userId });
  }

  // Per-bucket alias — the recommended, narrowly-routed binding. The
  // deterministic idempotencyKey rides the userEvents dedup short-circuit as
  // defense-in-depth (Section 6.3).
  await ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: eventName,
      userId,
      userEmail: userEmail ?? "",
      eventProperties: properties,
      idempotencyKey,
    },
  });

  // Generic form — emitted ONLY if a journey actually binds to it, so the
  // recursion-guarded generic event is not written for nothing (Section 8.5).
  const genericEvent = `bucket:${kind}`;
  if (registry.getByTriggerEvent(genericEvent).length > 0) {
    await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: genericEvent,
        userId,
        userEmail: userEmail ?? "",
        eventProperties: properties,
        idempotencyKey: `bucket:${bucket.id}:${userId}:${kind}:${epoch}:generic`,
      },
    });
  }
}
