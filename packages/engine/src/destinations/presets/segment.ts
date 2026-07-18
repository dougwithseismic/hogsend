import { WEBHOOK_EVENT_TYPES } from "../../lib/webhook-signing.js";
import { defineDestination } from "../define-destination.js";

/** Segment destination config read off `endpoint.config`. */
interface SegmentConfig {
  /** The Segment source WRITE KEY — used as the HTTP Basic username. */
  writeKey?: string;
  /**
   * Override the Segment HTTP Tracking API base (e.g. an EU region or a proxy).
   * Defaults to `https://api.segment.io`. The `/v1/track` path is appended.
   */
  host?: string;
  /**
   * OPTIONAL per-destination event-name remap, applied to `envelope.type` before
   * building the track body (identity by default). Lets a destination project a
   * canonical spine name onto an existing Segment event name.
   */
  eventNames?: Record<string, string>;
}

/**
 * Segment HTTP Tracking API destination — posts each catalog event to
 * `POST /v1/track` as a Segment `track` call. Auth is HTTP Basic with the source
 * write key as the username and an empty password (Segment's documented scheme).
 *
 * Credentials live in `endpoint.config` (`{ writeKey, host?, eventNames? }`). A
 * missing `config.writeKey` is a CONFIG error — a thrown transform is a
 * non-retryable permanent failure (straight to the DLQ).
 *
 * Identity: `userId` is taken from the envelope's `userId ?? to ?? userEmail`
 * (the same chain the PostHog destination uses), so an open/click with a known
 * user is attributed; an anonymous hit falls back to the email address.
 */
export const segmentDestination = defineDestination({
  meta: {
    id: "segment",
    name: "Segment",
    description:
      "Forward email-lifecycle events to a Segment source via the HTTP Tracking API.",
  },
  events: [...WEBHOOK_EVENT_TYPES],
  transform(envelope, ctx) {
    const config = (ctx.endpoint.config ?? {}) as SegmentConfig;
    if (!config.writeKey) {
      throw new Error(
        "segment destination is missing config.writeKey (non-retryable config error)",
      );
    }
    const host = config.host ?? "https://api.segment.io";

    // impact.digest has no subject identity; the fallback below would emit
    // a junk track keyed on `anonymousId: envelope.id` — noise. Skipping
    // is honest.
    if (envelope.type === "impact.digest") return null;
    const data = envelope.data as {
      userId?: string | null;
      to?: string | null;
      userEmail?: string | null;
    };
    const userId = data.userId ?? data.to ?? data.userEmail ?? undefined;
    const eventName = config.eventNames?.[envelope.type] ?? envelope.type;
    // HTTP Basic: base64("<writeKey>:"). Empty password per Segment's docs.
    const basic = Buffer.from(`${config.writeKey}:`).toString("base64");
    return {
      url: `${host}/v1/track`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${basic}`,
      },
      body: JSON.stringify({
        ...(userId ? { userId } : { anonymousId: envelope.id }),
        event: eventName,
        timestamp: envelope.timestamp,
        messageId: envelope.id,
        properties: { ...envelope.data, $lib: "hogsend" },
      }),
    };
  },
});
