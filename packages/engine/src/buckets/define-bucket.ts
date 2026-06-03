import type { BucketMeta } from "@hogsend/core/types";
import type { hatchet } from "../lib/hatchet.js";

export interface DefinedBucket {
  meta: BucketMeta;
  /**
   * The only task a bucket ever holds is the opt-in per-user fast-expiry timer,
   * which is a DURABLE task (it `ctx.sleepFor`s — Section 6.5), so the type MUST
   * be the durableTask return type, mirroring
   * `DefinedJourney.task = ReturnType<typeof hatchet.durableTask>`
   * (define-journey.ts:34) — NOT `hatchet.task`. The common case is
   * declarative-only (no task), like webhookSources; the engine-wide
   * `bucketReconcileTask` handles time-based leaves regardless.
   */
  task?: ReturnType<typeof hatchet.durableTask>;
}

export function defineBucket(options: { meta: BucketMeta }): DefinedBucket {
  // bucketMetaSchema.parse happens at BucketRegistry.register (the journey
  // precedent). defineBucket stays a PURE passthrough — identical in shape to
  // defineWebhookSource (define-webhook-source.ts:30-34) — and does NOT branch
  // on meta or construct any task. This keeps the three primitives consistent
  // and avoids building a Hatchet durableTask at module-load before validation
  // has run. The fast-expiry durableTask is synthesized later, at worker build,
  // by selectBucketTasks(buckets, enabled) reading meta.fastExpiry (Section 9.4)
  // — that is the single place a bucket's task is constructed, AFTER the
  // registry has validated the meta.
  return { meta: options.meta };
}
