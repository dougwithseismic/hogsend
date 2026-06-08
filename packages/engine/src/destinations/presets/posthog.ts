import { WEBHOOK_EVENT_TYPES } from "../../lib/webhook-signing.js";
import { defineDestination } from "../define-destination.js";

/** PostHog destination config read off `endpoint.config`. */
interface PostHogConfig {
  apiKey?: string;
  host?: string;
  /**
   * OPTIONAL per-destination event-name remap, applied to `envelope.type` before
   * building the capture body. Defaults to identity (no remap).
   *
   * `email.clicked` is the CANONICAL spine event name. The legacy fire-and-forget
   * PostHog path captured clicks as `email.link_clicked`, so to preserve existing
   * PostHog insights built on that name, set
   * `eventNames: { "email.clicked": "email.link_clicked" }`. Any catalog event can
   * be remapped this way; absent or unmapped keys pass through unchanged.
   */
  eventNames?: Record<string, string>;
}

/**
 * PostHog capture destination. Credentials live in `endpoint.config`
 * (`{ apiKey, host?, eventNames? }`), not a fake `whsec_`. A missing
 * `config.apiKey` is a CONFIG error — the delivery task treats a thrown
 * transform as a non-retryable permanent failure (straight to the DLQ).
 *
 * Byte-for-byte identical to the P1 internal `posthog` adapter: same capture
 * URL, same `{ api_key, event, distinct_id, timestamp, properties }` body, same
 * `$lib: "hogsend"` marker, same `userId ?? to ?? userEmail` distinct-id chain.
 */
export const posthogDestination = defineDestination({
  meta: {
    id: "posthog",
    name: "PostHog",
    description:
      "Fan email-lifecycle events out to a PostHog project (capture endpoint).",
  },
  // PostHog mirrors the whole catalog; the email funnel is the headline use but
  // any catalog event can be captured. Subscription is still scoped per-endpoint
  // via `event_types`, so an endpoint only receives what it subscribed to.
  events: [...WEBHOOK_EVENT_TYPES],
  transform(envelope, ctx) {
    const config = (ctx.endpoint.config ?? {}) as PostHogConfig;
    if (!config.apiKey) {
      throw new Error(
        "posthog destination is missing config.apiKey (non-retryable config error)",
      );
    }
    const host = config.host ?? "https://us.i.posthog.com";
    const data = envelope.data as {
      userId?: string | null;
      to?: string | null;
      userEmail?: string | null;
    };
    const distinctId = data.userId ?? data.to ?? data.userEmail ?? undefined;
    // Optional event-name remap (identity by default).
    const eventName = config.eventNames?.[envelope.type] ?? envelope.type;
    return {
      url: `${host}/capture/`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: config.apiKey,
        event: eventName,
        distinct_id: distinctId,
        timestamp: envelope.timestamp,
        properties: { ...envelope.data, $lib: "hogsend" },
      }),
    };
  },
});
