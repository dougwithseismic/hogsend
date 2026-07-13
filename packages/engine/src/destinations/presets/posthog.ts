import type { OutboundPayloads } from "../../lib/outbound.js";
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
   * other identifier. Anything but a boolean `true` (config is a loose jsonb
   * bag) leaves `contact.*` events SKIPPED entirely — they carry no
   * `userId`/`to`, so the generic capture branch could never address them
   * correctly anyway.
   */
  syncPersons?: boolean;
  /**
   * The person property a scope-`all` unsubscribe sets (default
   * `hogsend_unsubscribed`) — overridable like the bucket mirror's
   * `postHogPropertyKey`, so operators can match their own naming scheme.
   */
  unsubscribedPropertyKey?: string;
}

/**
 * The one place the PostHog capture request is built — all three transform
 * branches (person `$set`, `email.action`, generic catalog capture) share it,
 * so a change to the capture wire shape happens once.
 */
function captureRequest(opts: {
  host: string;
  apiKey: string;
  event: string;
  distinctId: string | undefined;
  timestamp: string;
  properties: Record<string, unknown>;
}): {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
} {
  return {
    url: `${opts.host}/capture/`,
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: opts.apiKey,
      event: opts.event,
      distinct_id: opts.distinctId,
      timestamp: opts.timestamp,
      properties: { ...opts.properties, $lib: "hogsend" },
    }),
  };
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
      // Strict `=== true`: config is a loose jsonb bag, and a stray string
      // value ("false") must not enable the sync.
      if (config.syncPersons !== true) return null;

      const setCapture = (distinctId: string, set: Record<string, unknown>) =>
        captureRequest({
          host,
          apiKey: config.apiKey as string,
          event: "$set",
          distinctId,
          timestamp: envelope.timestamp,
          properties: { $set: set },
        });

      if (
        envelope.type === "contact.created" ||
        envelope.type === "contact.updated"
      ) {
        const contact =
          envelope.data as unknown as OutboundPayloads["contact.updated"];
        const props = contact.properties ?? {};
        // Nothing to propagate — a successful no-op, not a delivery failure.
        if (Object.keys(props).length === 0) return null;
        // The contact's canonical key (externalId ?? id) — the same distinct
        // id the identify loop and hs_t stitch use, so the $set lands on the
        // person the contact's web sessions and email events already share.
        // Known limitation: the serialized payload omits anonymousId, so an
        // anonymous-keyed contact syncs under its row id rather than its
        // anonymous key — fixed properly when contact.* payloads grow a
        // first-class `contactKey` field.
        return setCapture(contact.externalId ?? contact.id, props);
      }

      if (envelope.type === "contact.unsubscribed") {
        const data =
          envelope.data as unknown as OutboundPayloads["contact.unsubscribed"];
        // Category-scoped opt-outs are too granular for a person flag, and a
        // payload without externalId can't be addressed safely (the canonical
        // key of an email-only contact is its row id, which this payload
        // doesn't carry — guessing by email would mint a wrong person).
        if (data.scope !== "all" || !data.externalId) return null;
        const flag = config.unsubscribedPropertyKey ?? "hogsend_unsubscribed";
        return setCapture(data.externalId, { [flag]: true });
      }

      if (envelope.type === "contact.control_group") {
        // Global control group membership (impact plan §4.4): a person flag
        // so PostHog insights/experiments can slice program-level lift. The
        // engine owns assignment (deterministic, durable-path); PostHog gets
        // the raw material. Identity-less sends carry no addressable key.
        const data =
          envelope.data as unknown as OutboundPayloads["contact.control_group"];
        if (!data.userId) return null;
        return setCapture(data.userId, { hogsend_control_group: true });
      }

      // contact.deleted: PostHog person deletion is a private-API operation,
      // not a capture — out of scope for this rail.
      return null;
    }

    // Holdout membership as a person property (impact plan §4.4): when
    // person sync is on, journey.heldout becomes a per-journey $set flag
    // (`hogsend_holdout_<journeyId>: true`) so PostHog can slice any insight
    // by holdout membership. With sync off it falls through to the generic
    // event capture below — the event stream alone still records diversion.
    if (envelope.type === "journey.heldout" && config.syncPersons === true) {
      const heldout =
        envelope.data as unknown as OutboundPayloads["journey.heldout"];
      return captureRequest({
        host,
        apiKey: config.apiKey,
        event: "$set",
        distinctId: heldout.userId,
        timestamp: envelope.timestamp,
        properties: {
          $set: { [`hogsend_holdout_${heldout.journeyId}`]: true },
        },
      });
    }

    const data = envelope.data as {
      userId?: string | null;
      to?: string | null;
      userEmail?: string | null;
      anonymousId?: string | null;
    };
    // `anonymousId` covers anon-tier arrivals (`link.arrived`): a raw browser
    // anon id IS a legitimate PostHog distinct_id, and without it the capture
    // would ship no distinct_id at all — PostHog 400s and the delivery
    // dead-letters (<500 = non-retryable).
    const distinctId =
      data.userId ?? data.anonymousId ?? data.to ?? data.userEmail ?? undefined;
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
      return captureRequest({
        host,
        apiKey: config.apiKey,
        event: action.event,
        distinctId,
        timestamp: envelope.timestamp,
        properties: {
          ...(action.properties ?? {}),
          emailSendId: action.emailSendId,
          templateKey: action.templateKey,
          linkId: action.linkId,
        },
      });
    }
    // Optional event-name remap (identity by default).
    const eventName = config.eventNames?.[envelope.type] ?? envelope.type;
    return captureRequest({
      host,
      apiKey: config.apiKey,
      event: eventName,
      distinctId,
      timestamp: envelope.timestamp,
      properties: envelope.data as Record<string, unknown>,
    });
  },
});
