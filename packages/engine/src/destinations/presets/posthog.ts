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
  /**
   * Person-property propagation (the contact → analytics-person rail). When
   * true, `contact.created` / `contact.updated` events become `$set` captures
   * of the contact's `properties` under the contact's canonical key — the
   * SAME distinct id the identify loop uses — so PostHog person profiles
   * accumulate contact truth (plan, role, lifecycle stage…) and cohorts can
   * segment on it. `contact.unsubscribed` (scope `all`) sets
   * `hogsend_unsubscribed: true`.
   *
   * Privacy posture: ONLY `contact.properties` syncs — never email or any
   * other identifier. When false/absent, `contact.*` events are SKIPPED
   * entirely (they carry no `userId`/`to`, so the generic capture branch
   * could never address them correctly anyway).
   */
  syncPersons?: boolean;
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

    // Person-property propagation: `contact.*` events carry a contact payload
    // (id/externalId/email/properties), NOT the userId/to identity chain the
    // generic capture branch keys on — so they are handled here exclusively
    // and SKIPPED (null) when `config.syncPersons` is off.
    if (envelope.type.startsWith("contact.")) {
      if (!config.syncPersons) return null;

      const capture = (distinctId: string, properties: object) =>
        ({
          url: `${host}/capture/`,
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: config.apiKey,
            event: "$set",
            distinct_id: distinctId,
            timestamp: envelope.timestamp,
            properties: { ...properties, $lib: "hogsend" },
          }),
        }) as const;

      if (
        envelope.type === "contact.created" ||
        envelope.type === "contact.updated"
      ) {
        const contact = envelope.data as {
          id: string;
          externalId: string | null;
          properties: Record<string, unknown> | null;
        };
        const props = contact.properties ?? {};
        // Nothing to propagate — a successful no-op, not a delivery failure.
        if (Object.keys(props).length === 0) return null;
        // The contact's canonical key (externalId ?? id) — the same distinct
        // id the identify loop and hs_t stitch use, so the $set lands on the
        // person the contact's web sessions and email events already share.
        return capture(contact.externalId ?? contact.id, { $set: props });
      }

      if (envelope.type === "contact.unsubscribed") {
        const data = envelope.data as {
          externalId: string | null;
          scope: "all" | "category";
        };
        // Category-scoped opt-outs are too granular for a person flag, and a
        // payload without externalId can't be addressed safely (the canonical
        // key of an email-only contact is its row id, which this payload
        // doesn't carry — guessing by email would mint a wrong person).
        if (data.scope !== "all" || !data.externalId) return null;
        return capture(data.externalId, {
          $set: { hogsend_unsubscribed: true },
        });
      }

      // contact.deleted: PostHog person deletion is a private-API operation,
      // not a capture — out of scope for this rail.
      return null;
    }

    const data = envelope.data as {
      userId?: string | null;
      to?: string | null;
      userEmail?: string | null;
    };
    const distinctId = data.userId ?? data.to ?? data.userEmail ?? undefined;
    // `email.action` is the semantic-link envelope: the CONSUMER's event name
    // (data.event, e.g. "nps.submitted") is what PostHog should capture, with
    // the author's properties flattened to the top level. Other catalog events
    // capture under their spine name (with the optional remap).
    if (envelope.type === "email.action") {
      const action = envelope.data as {
        event: string;
        properties: Record<string, unknown> | null;
        emailSendId: string;
        templateKey: string | null;
        linkId: string;
        linkUrl: string;
        to: string;
        userId: string | null;
        at: string;
      };
      return {
        url: `${host}/capture/`,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: config.apiKey,
          event: action.event,
          distinct_id: distinctId,
          timestamp: envelope.timestamp,
          properties: {
            ...(action.properties ?? {}),
            emailSendId: action.emailSendId,
            templateKey: action.templateKey,
            linkId: action.linkId,
            $lib: "hogsend",
          },
        }),
      };
    }
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
