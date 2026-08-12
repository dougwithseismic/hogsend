import {
  HOGSEND_RELAY_EVENT_VERSION,
  hogsendRelayEmailEventSchema,
  parseHogsendRelayWebhook,
} from "@hogsend/plugin-hogsend";
import { describe, expect, it } from "vitest";
import {
  normalizeSesNotification,
  SES_CONSUMED_EVENT_TYPES,
  sesEventDedupeKey,
} from "../lib/ses-events";
import {
  sesBounceNotification,
  sesClickNotification,
  sesComplaintNotification,
  sesDeliveryDelayNotification,
  sesDeliveryNotification,
  sesOpenNotification,
  sesRejectNotification,
  sesSendNotification,
  tagForEnvironment,
} from "./helpers/ses-notifications";

/**
 * SES notification → `HogsendRelayEmailEvent`, against AWS's OWN documented
 * examples (see `helpers/ses-notifications.ts` for the source URL).
 *
 * The round-trip tests at the bottom are the ones that matter: they run the
 * normalizer's output back through `plugin-hogsend.parseWebhook`, which is the
 * code the tenant instance actually runs. A control plane that emitted a shape
 * the plugin rejects would drop every bounce silently, which is precisely the
 * failure PRD 05 exists to prevent.
 */

function normalize(payload: Record<string, unknown>) {
  const result = normalizeSesNotification(payload);
  if (!result) throw new Error("expected the notification to be consumed");
  return result;
}

describe("normalizeSesNotification — what is consumed", () => {
  it("consumes exactly Delivery, Bounce, Complaint, DeliveryDelay and Reject", () => {
    expect([...SES_CONSUMED_EVENT_TYPES]).toEqual([
      "Delivery",
      "Bounce",
      "Complaint",
      "DeliveryDelay",
      "Reject",
    ]);
  });

  it.each([
    ["Send", sesSendNotification()],
    ["Open", sesOpenNotification()],
    ["Click", sesClickNotification()],
  ])("drops %s rather than normalizing it", (_name, payload) => {
    // Opens and clicks are FIRST-PARTY and sovereign (the engine's /v1/t/o and
    // /v1/t/c). Consuming SES's would give the engine two disagreeing sources
    // of truth for one fact, so this wire cannot express one.
    expect(normalizeSesNotification(payload)).toBeNull();
  });

  it("returns null for a payload that is not an SES event at all", () => {
    expect(normalizeSesNotification({ hello: "world" })).toBeNull();
    expect(normalizeSesNotification("not json")).toBeNull();
    expect(normalizeSesNotification(null)).toBeNull();
  });

  it("reads `notificationType` as well as `eventType`", () => {
    // Identity-level feedback notifications name the field `notificationType`;
    // configuration-set event publishing names it `eventType`. Both are SES.
    const { eventType, ...rest } = sesBounceNotification();
    expect(eventType).toBe("Bounce");
    const result = normalize({ ...rest, notificationType: "Bounce" });
    expect(result.event.type).toBe("email.bounced");
  });
});

describe("normalizeSesNotification — Bounce", () => {
  it("normalizes AWS's Bounce example", () => {
    const { event } = normalize(sesBounceNotification());

    expect(event).toMatchObject({
      version: HOGSEND_RELAY_EVENT_VERSION,
      type: "email.bounced",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      recipients: ["recipient@example.com"],
      occurredAt: "2017-08-05T00:41:02.669Z",
      bounce: {
        type: "Permanent",
        subType: "General",
        reason: "smtp; 550 5.1.1 user unknown",
      },
    });
    // The wire is valid by the PLUGIN's schema, not merely by ours.
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });

  it("carries SES's bounceType VERBATIM rather than pre-classifying it", () => {
    // PRD 04 owns classification (`classifyHogsendRelayBounce`), so the control
    // plane never guesses. A relay that mapped `Undetermined` to `permanent`
    // here would suppress a deliverable address with no way to tell afterwards.
    const payload = sesBounceNotification();
    (payload.bounce as Record<string, unknown>).bounceType = "Undetermined";
    (payload.bounce as Record<string, unknown>).bounceSubType = "Undetermined";
    expect(normalize(payload).event.bounce?.type).toBe("Undetermined");
  });

  it("names ONLY the recipients SES said bounced", () => {
    // NOT `mail.destination`. A bounce for one address on a five-address send
    // would otherwise arrive naming all five, and the engine suppresses on a
    // permanent bounce — four deliverable addresses killed by a fallback.
    const payload = sesBounceNotification();
    (payload.mail as Record<string, unknown>).destination = [
      "recipient@example.com",
      "innocent@example.com",
    ];
    expect(normalize(payload).event.recipients).toEqual([
      "recipient@example.com",
    ]);
  });

  it("keeps the raw notification for debugging", () => {
    const payload = sesBounceNotification();
    expect(normalize(payload).event.raw).toEqual(payload);
  });
});

describe("normalizeSesNotification — Complaint", () => {
  it("normalizes AWS's Complaint example", () => {
    const { event } = normalize(sesComplaintNotification());

    expect(event).toMatchObject({
      type: "email.complained",
      recipients: ["recipient@example.com"],
      occurredAt: "2017-08-05T00:41:02.669Z",
    });
    expect(event.bounce?.type).toBe("Complaint");
    expect(event.bounce?.reason).toBe("abuse");
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });

  it("names only the complained recipients", () => {
    const payload = sesComplaintNotification();
    (payload.mail as Record<string, unknown>).destination = [
      "recipient@example.com",
      "innocent@example.com",
    ];
    expect(normalize(payload).event.recipients).toEqual([
      "recipient@example.com",
    ]);
  });
});

describe("normalizeSesNotification — Delivery", () => {
  it("normalizes AWS's Delivery example", () => {
    const { event } = normalize(sesDeliveryNotification());

    expect(event).toMatchObject({
      type: "email.delivered",
      recipients: ["recipient@example.com"],
      occurredAt: "2016-10-19T23:21:04.133Z",
    });
    // A delivery is not a bounce, and attaching one would drive the engine's
    // suppression path off a message that arrived.
    expect(event.bounce).toBeUndefined();
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("normalizeSesNotification — DeliveryDelay", () => {
  it("normalizes AWS's DeliveryDelay example", () => {
    const { event } = normalize(sesDeliveryDelayNotification());

    expect(event).toMatchObject({
      type: "email.delivery_delayed",
      recipients: ["recipient@example.com"],
      occurredAt: "2020-06-16T00:25:40.095Z",
    });
    expect(event.bounce).toBeUndefined();
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });
});

describe("normalizeSesNotification — Reject (PRD 18)", () => {
  it("normalizes AWS's Reject example", () => {
    const { event } = normalize(sesRejectNotification());

    expect(event).toMatchObject({
      type: "email.rejected",
      messageId: "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
      // The `reject` object carries NO timestamp of its own — `reason` is its
      // only documented field — so `mail.timestamp` is the honest answer.
      occurredAt: "2016-10-14T17:38:15.211Z",
      reject: { reason: "Bad content" },
    });
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });

  it("attaches NO bounce block", () => {
    // A reject is not a bounce and must never touch the suppression path: the
    // recipient's address is fine, our content carried a virus.
    expect(normalize(sesRejectNotification()).event.bounce).toBeUndefined();
  });

  it("names `mail.destination`, because a reject is MESSAGE-scoped", () => {
    // The one event type where `mail.destination` is correct rather than a
    // convenience fallback: SES stopped processing the MESSAGE, so every
    // destination is affected identically. Safe here precisely because
    // `email.rejected` suppresses nothing.
    const payload = sesRejectNotification();
    (payload.mail as Record<string, unknown>).destination = [
      "one@example.com",
      "two@example.com",
    ];
    expect(normalize(payload).event.recipients).toEqual([
      "one@example.com",
      "two@example.com",
    ]);
  });

  it("carries the reason VERBATIM rather than parsing or mapping it", () => {
    // `Bad content` is the only value AWS documents TODAY. A normalizer that
    // switched on it would silently drop the next one.
    const payload = sesRejectNotification();
    (payload.reject as Record<string, unknown>).reason =
      "Some future AWS reject reason";
    expect(normalize(payload).event.reject?.reason).toBe(
      "Some future AWS reject reason",
    );
  });

  it("is still consumed when SES states no reason at all", () => {
    // Losing the whole terminal event because one optional string was absent
    // would put the send back in the exact limbo this PRD exists to end.
    const payload = sesRejectNotification();
    delete (payload as Record<string, unknown>).reject;
    const { event } = normalize(payload);
    expect(event.type).toBe("email.rejected");
    expect(event.reject).toBeUndefined();
    expect(hogsendRelayEmailEventSchema.safeParse(event).success).toBe(true);
  });

  it("has a dedupe key stable across redeliveries and distinct per message", () => {
    // SNS is at-least-once and a Reject has no `feedbackId`, so the key rests
    // on `mail.timestamp` + messageId — both fixed for one message.
    expect(normalize(sesRejectNotification()).dedupeKey).toBe(
      normalize(sesRejectNotification()).dedupeKey,
    );
    expect(normalize(sesRejectNotification()).dedupeKey).not.toBe(
      normalize(sesDeliveryNotification()).dedupeKey,
    );
  });
});

describe("normalizeSesNotification — tenant resolution", () => {
  it("prefers `ses:tenant-name` and falls back to `ses:configuration-set`", () => {
    const withBoth = tagForEnvironment(
      sesBounceNotification(),
      "11111111-1111-4111-8111-111111111111",
    );
    expect(normalize(withBoth).tenantName).toBe(
      "env-11111111-1111-4111-8111-111111111111",
    );

    const configSetOnly = tagForEnvironment(
      sesBounceNotification(),
      "22222222-2222-4222-8222-222222222222",
      { tenantTag: false },
    );
    expect(normalize(configSetOnly).tenantName).toBe(
      "env-22222222-2222-4222-8222-222222222222",
    );
    expect(normalize(configSetOnly).configurationSetName).toBe(
      "env-22222222-2222-4222-8222-222222222222",
    );
  });

  it("reports a null tenant rather than guessing when neither tag is present", () => {
    const payload = sesBounceNotification();
    (payload.mail as Record<string, unknown>).tags = {};
    expect(normalize(payload).tenantName).toBeNull();
  });
});

describe("sesEventDedupeKey", () => {
  it("is stable across two identical deliveries of one event", () => {
    // SNS delivery is at-least-once, so the same notification arrives twice.
    expect(normalize(sesBounceNotification()).dedupeKey).toBe(
      normalize(sesBounceNotification()).dedupeKey,
    );
  });

  it("differs between event types on one message", () => {
    // A message legitimately produces a Delivery AND (later) a Complaint.
    expect(normalize(sesDeliveryNotification()).dedupeKey).not.toBe(
      normalize(sesComplaintNotification()).dedupeKey,
    );
  });

  it("differs between two bounces of the same message at different times", () => {
    const later = sesBounceNotification();
    (later.bounce as Record<string, unknown>).timestamp =
      "2017-08-06T00:41:02.669Z";
    (later.bounce as Record<string, unknown>).feedbackId =
      "another-feedback-id";
    expect(normalize(later).dedupeKey).not.toBe(
      normalize(sesBounceNotification()).dedupeKey,
    );
  });

  it("is a hex digest, not the payload", () => {
    const key = sesEventDedupeKey({
      type: "email.bounced",
      messageId: "m",
      occurredAt: "2026-01-01T00:00:00.000Z",
      feedbackId: "f",
      recipients: ["a@example.com"],
    });
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// The round trip — control plane out, tenant instance in
// ---------------------------------------------------------------------------

describe("round trip through plugin-hogsend.parseWebhook", () => {
  it("a Bounce becomes an EmailEvent classified `permanent`", () => {
    const { event } = normalize(sesBounceNotification());
    const parsed = parseHogsendRelayWebhook(JSON.stringify(event));

    expect(parsed.type).toBe("email.bounced");
    expect(parsed.messageId).toBe(
      "EXAMPLE7c191be45-e9aedb9a-02f9-4d12-a87d-dd0099a07f8a-000000",
    );
    expect(parsed.recipients).toEqual(["recipient@example.com"]);
    // The EARS line, proved end to end: SES `Permanent` → engine `permanent`.
    // The classification lives in the PLUGIN, so this is the only place that
    // can assert it truthfully.
    expect(parsed.bounce?.class).toBe("permanent");
    expect(parsed.bounce?.code).toBe("Permanent/General");
    expect(parsed.bounce?.reason).toBe("smtp; 550 5.1.1 user unknown");
  });

  it("a Transient bounce becomes `transient`", () => {
    const payload = sesBounceNotification();
    (payload.bounce as Record<string, unknown>).bounceType = "Transient";
    (payload.bounce as Record<string, unknown>).bounceSubType = "MailboxFull";

    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(payload).event),
    );
    expect(parsed.bounce?.class).toBe("transient");
    expect(parsed.bounce?.code).toBe("Transient/MailboxFull");
  });

  it("an unrecognized bounceType becomes `unknown`, never `permanent`", () => {
    const payload = sesBounceNotification();
    (payload.bounce as Record<string, unknown>).bounceType =
      "SomeFutureAwsBounceType";

    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(payload).event),
    );
    // Recorded, never suppressing. Defaulting to `permanent` would let one new
    // SES bounce type quietly unsubscribe a whole list.
    expect(parsed.bounce?.class).toBe("unknown");
  });

  it("a Complaint becomes an EmailEvent classified `complaint`", () => {
    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(sesComplaintNotification()).event),
    );
    expect(parsed.type).toBe("email.complained");
    expect(parsed.bounce?.class).toBe("complaint");
  });

  it("a Delivery becomes an EmailEvent with no bounce at all", () => {
    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(sesDeliveryNotification()).event),
    );
    expect(parsed.type).toBe("email.delivered");
    expect(parsed.bounce).toBeUndefined();
  });

  it("a DeliveryDelay becomes an EmailEvent with no bounce", () => {
    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(sesDeliveryDelayNotification()).event),
    );
    expect(parsed.type).toBe("email.delivery_delayed");
    expect(parsed.bounce).toBeUndefined();
  });

  it("a Reject becomes an EmailEvent with a reason and NO bounce", () => {
    // The EARS line proved end to end, across both sides of the wire: SES
    // `Reject` → `email.rejected` carrying `Bad content`, and nothing the
    // engine's suppression path can read.
    const parsed = parseHogsendRelayWebhook(
      JSON.stringify(normalize(sesRejectNotification()).event),
    );
    expect(parsed.type).toBe("email.rejected");
    expect(parsed.reject).toEqual({ reason: "Bad content" });
    expect(parsed.bounce).toBeUndefined();
  });
});
