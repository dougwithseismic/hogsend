import { defineBucket } from "@hogsend/engine";

/**
 * The far end of the GTM loop: contacts whose blended fit-plus-behaviour score
 * cleared the bar. `gtmScore` is written by the nightly `gtm-score` workflow
 * (src/workflows/gtm-score.ts) as a real JSON NUMBER — `conditions/property.ts`
 * does NO coercion, so a stringified `"34"` would silently never match `gte(20)`.
 *
 * The key is FLAT and TOP-LEVEL. `evaluatePropertyConditions` reads
 * `journeyContext["gtmScore"]`; a dotted path such as `properties.gtmScore`
 * never resolves.
 *
 * NOT `timeBased`, and that is load-bearing rather than an omission.
 * `bucketReconcileTask` deliberately skips non-time-based buckets, so this
 * bucket is ONLY ever evaluated during ingest — which is exactly why the nightly
 * scorer must write through `ingestEvent` and not update `contacts` directly.
 * `resolveOrCreateContact` writes the jsonb but does not re-run
 * `checkBucketMembership`; a direct update would leave this bucket frozen
 * forever with no error to notice.
 *
 * No `entryLimit` (defaults to unlimited): a score is a continuous quantity, so
 * a contact should be free to cross back over the bar as its behaviour changes.
 * Nothing here spends money, so re-entry is cheap.
 */
export const gtmQualified = defineBucket({
  meta: {
    id: "gtm-qualified",
    name: "GTM qualified",
    description: "Blended fit-plus-behaviour score of 20 or more.",
    enabled: true,
    criteria: (b) => b.prop("gtmScore").gte(20),
  },
});
