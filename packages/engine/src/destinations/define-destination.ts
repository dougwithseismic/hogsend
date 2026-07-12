import type { webhookEndpoints } from "@hogsend/db";
import type { Logger } from "../lib/logger.js";
import type { OutboundEventName } from "../lib/outbound.js";

/**
 * Public, code-first authoring layer for OUTBOUND destinations — the symmetric
 * twin of {@link defineWebhookSource} on the inbound side.
 *
 * A destination is a delivery-time TRANSFORM keyed by `webhook_endpoints.kind`.
 * It receives the FROZEN vendor-neutral envelope (`{ id, type, timestamp, data }`)
 * `emitOutbound` wrote to `webhook_deliveries.payload`, plus the LIVE endpoint
 * row read at delivery time, and returns the concrete HTTP request to make. All
 * of the durable delivery machinery (retry / backoff / DLQ / reaper / CAS /
 * idempotency) is unchanged — it operates on the delivery ROW, never on the wire
 * — so a code-defined destination inherits every bit of it for free.
 *
 * Like `defineWebhookSource`, this is an identity / validating function: it
 * returns its argument unchanged so the call site reads declaratively and a typo
 * in the shape is a compile error. The real wiring happens when the destination
 * is registered (via `createHogsendClient({ destinations })` or an env preset)
 * into the process {@link getDestinationRegistry} the delivery task reads.
 *
 * NOTE: `defineDestination` is for event FAN-OUT to product/data tools
 * (PostHog, Segment, Slack, a CRM, a warehouse). Ad-platform conversion
 * forwarding (Meta CAPI, Google Enhanced Conversions) is Hogsend-native but
 * lives in its own sibling layer (`defineConversionDestination`, per
 * docs/revenue-attribution-plan.md) — it needs identifier hashing, click-id
 * joins, and deterministic event_id idempotency this generic pipe deliberately
 * does not have. It is NOT deferred to any third-party CDP: the money path has
 * no external dependency.
 */

/** A live `webhook_endpoints` row, as read by the delivery task. */
export type WebhookEndpointRow = typeof webhookEndpoints.$inferSelect;

/**
 * The frozen envelope stored on `webhook_deliveries.payload` and passed to a
 * destination transform verbatim. Identical to the shape `emitOutbound` writes.
 */
export interface DestinationEnvelope {
  id: string;
  type: string;
  timestamp: string;
  data: Record<string, unknown>;
}

/**
 * Side context handed to a transform. Deliberately tiny — a transform derives
 * its request from the envelope + the endpoint's `config`/`secret`. `logger` is
 * provided for diagnostics; mutating external state from a transform is a
 * mistake (it runs once per delivery attempt, including retries).
 */
export interface DestinationCtx {
  endpoint: WebhookEndpointRow;
  logger: Logger;
}

/**
 * The concrete HTTP request a transform resolves the envelope + endpoint into —
 * the same contract the internal P1 adapters returned.
 */
export interface DestinationTransformResult {
  url: string;
  method?: string;
  headers: Record<string, string>;
  /**
   * EXACT bytes to send. For the `webhook` preset these are the SIGNED bytes —
   * never re-stringify them between sign and send (the signature covers them).
   */
  body: string;
  /**
   * Optional success classifier. When absent, the delivery task uses the
   * default 2xx rule (`status >= 200 && status < 300`). A destination whose 2xx
   * body still encodes a logical error can override this.
   */
  isSuccess?: (status: number, bodySnippet: string) => boolean;
}

export interface DestinationMeta {
  /**
   * The stable id — also the value stored in `webhook_endpoints.kind`. An
   * endpoint with `kind === meta.id` is delivered through this destination's
   * transform. `"webhook"` and `"posthog"` are the shipped preset ids.
   */
  id: string;
  name: string;
  description?: string;
}

export interface DefinedDestination {
  meta: DestinationMeta;
  /** The outbound catalog events this destination accepts. */
  events: OutboundEventName[];
  /**
   * Resolve the frozen envelope + live endpoint into a concrete HTTP request.
   * Return `null` to SKIP delivery for that envelope (the delivery task treats a
   * skip as a successful no-op — the row is marked delivered without a POST).
   * A THROW is a non-retryable config error (straight to the DLQ).
   */
  transform(
    envelope: DestinationEnvelope,
    ctx: DestinationCtx,
  ): DestinationTransformResult | null;
}

export function defineDestination(def: DefinedDestination): DefinedDestination {
  return def;
}
