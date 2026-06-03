import { BucketRegistry } from "@hogsend/core/registry";
import { parseEnabledFilter } from "../journeys/registry.js";
import { bucketExpiryTask } from "../workflows/bucket-reconcile.js";
import type { DefinedBucket } from "./define-bucket.js";
import { setBucketRegistry } from "./registry-singleton.js";

/**
 * Build a {@link BucketRegistry} from an injected array of buckets, applying the
 * enabled filter, and install it as the process singleton (so the real-time
 * ingest path and the reconcile cron can resolve it). Returns the registry.
 *
 * `parseEnabledFilter` (journeys/registry.ts) is reused as-is — `ENABLED_BUCKETS`
 * honours the same `"*"`-or-csv contract as `ENABLED_JOURNEYS` (Section 9.3).
 * `BucketRegistry.register()` runs `bucketMetaSchema.parse()` internally, so no
 * separate validation step is needed here.
 */
export function buildBucketRegistry(
  buckets: DefinedBucket[],
  enabledFilter?: string,
): BucketRegistry {
  const registry = new BucketRegistry();
  const enabled = parseEnabledFilter(enabledFilter);

  for (const bucket of buckets) {
    if (enabled === "*" || enabled.has(bucket.meta.id)) {
      registry.register(bucket.meta);
    }
  }

  setBucketRegistry(registry);
  return registry;
}

/**
 * Select the Hatchet durable tasks for the enabled buckets. This is the SINGLE
 * place a bucket's per-user fast-expiry timer task is constructed (Section
 * 4.3/9.4) — task construction happens at worker build, AFTER the registry has
 * validated every meta, never at module-load.
 *
 * Only `meta.fastExpiry` buckets contribute a task; the engine-wide
 * `bucketReconcileTask` (registered separately in `baseWorkflows`) owns
 * time-based leaves regardless. The fast-expiry timer is a single shared
 * `durableTask` keyed on `bucket:arm-expiry` (per-bucket arming is by event
 * payload, not per-bucket task instances), so it is registered once if ANY
 * enabled bucket opts in.
 */
export function selectBucketTasks(
  buckets: DefinedBucket[],
  enabledFilter?: string,
): NonNullable<DefinedBucket["task"]>[] {
  const enabled = parseEnabledFilter(enabledFilter);
  const hasFastExpiry = buckets.some(
    (b) =>
      (enabled === "*" || enabled.has(b.meta.id)) && b.meta.fastExpiry === true,
  );
  if (!hasFastExpiry) return [];

  // The single shared `bucket:arm-expiry` durableTask, registered ONCE because
  // any enabled bucket opts in (per-bucket arming is by event payload). Cast to
  // the DefinedBucket task shape — both are `hatchet.durableTask` returns.
  return [bucketExpiryTask as NonNullable<DefinedBucket["task"]>];
}
