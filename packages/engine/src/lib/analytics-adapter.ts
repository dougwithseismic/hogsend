import type { AnalyticsProvider, PostHogService } from "@hogsend/core";

/**
 * Wrap a legacy `PostHogService` (the deprecated PostHog-shaped interface
 * accepted by `createHogsendClient({ analytics })` since before the neutral
 * `AnalyticsProvider` contract existed) so it satisfies the contract the
 * engine now speaks internally. Capabilities are assumed-on: a hand-built
 * service predates capability reporting, and every method is best-effort
 * anyway.
 *
 * Mapping notes:
 * - `setPersonProperties.set` → `identify(distinctId, set)` (the legacy $set
 *   path). `setOnce` ALSO maps to `identify` — legacy services have no
 *   set-once wire, so overwrite semantics apply; `unset` maps to the legacy
 *   raw `$set` capture with `$unset`, mirroring what the bucket sync used to
 *   emit directly.
 */
export function wrapLegacyAnalyticsService(
  service: PostHogService,
): AnalyticsProvider {
  return {
    meta: {
      id: "custom",
      name: "Custom analytics service (legacy PostHogService shape)",
    },
    capabilities: { personReads: true, personWrites: true },

    getPersonProperties(distinctId) {
      return service.getPersonProperties(distinctId);
    },

    async setPersonProperties({ distinctId, set, setOnce, unset }) {
      const merged = { ...(setOnce ?? {}), ...(set ?? {}) };
      if (Object.keys(merged).length > 0) {
        service.identify(distinctId, merged);
      }
      if (unset?.length) {
        service.captureEvent({
          distinctId,
          event: "$set",
          properties: { $unset: unset },
        });
      }
    },

    capture(opts) {
      service.captureEvent(opts);
    },

    async shutdown() {
      await service.shutdown();
    },
  };
}

/**
 * Runtime discrimination for the `analytics` option union: a neutral
 * `AnalyticsProvider` carries `meta` + `capture`; the legacy `PostHogService`
 * carries `captureEvent` and no `meta`.
 */
export function isAnalyticsProvider(
  value: AnalyticsProvider | PostHogService,
): value is AnalyticsProvider {
  return (
    typeof (value as AnalyticsProvider).capture === "function" &&
    typeof (value as AnalyticsProvider).meta === "object"
  );
}
