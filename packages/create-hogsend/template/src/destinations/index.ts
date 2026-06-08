import type { DefinedDestination } from "@hogsend/engine";

/**
 * Code-defined OUTBOUND destinations for this app. A destination is a
 * delivery-time transform (`defineDestination()`) keyed by its `meta.id`, which
 * the engine matches against a `webhook_endpoints.kind`. It fans the outbound
 * event catalog (`contact.*`, `email.*`, `journey.completed`, `bucket.*`) out to
 * a product/data tool — PostHog, Segment, Slack, a CRM, a warehouse — reusing
 * the engine's durable retry / backoff / DLQ delivery machinery for free.
 *
 * The engine already ships `webhook` (the default signed POST), `posthog`,
 * `segment`, and `slack` presets — you do NOT need to redefine those. Add a
 * `defineDestination()` here only for a NEW destination shape, or to OVERRIDE a
 * preset of the same id. Pass this array to `createHogsendClient({ destinations })`
 * in BOTH src/index.ts and src/worker.ts. Edit freely — this is your content.
 *
 * NOTE: destinations are for event FAN-OUT, NOT ad-platform conversion
 * forwarding (CAPI) — that is deferred to PostHog CDP.
 */
export const destinations: DefinedDestination[] = [];
