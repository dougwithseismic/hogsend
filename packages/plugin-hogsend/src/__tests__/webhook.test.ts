import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyHogsendRelayBounce,
  createHogsendEmailProvider,
  HOGSEND_RELAY_EMAIL_EVENT_TYPES,
  HOGSEND_RELAY_EVENT_VERSION,
  HOGSEND_RELAY_SIGNATURE_HEADER,
  type HogsendRelayEmailEvent,
  hogsendRelayEmailEventSchema,
  parseHogsendRelayWebhook,
  signHogsendRelayWebhook,
} from "../index.js";

const SECRET = "whsec_hogsend_relay";

const DELIVERED: HogsendRelayEmailEvent = {
  version: HOGSEND_RELAY_EVENT_VERSION,
  type: "email.delivered",
  messageId: "0100018f-ses-message-id",
  recipients: ["user@example.com"],
  occurredAt: "2026-08-10T09:30:00.000Z",
  raw: { notificationType: "Delivery" },
};

function signed(event: unknown, secret = SECRET) {
  const payload = JSON.stringify(event);
  return {
    payload,
    headers: {
      [HOGSEND_RELAY_SIGNATURE_HEADER]: signHogsendRelayWebhook({
        payload,
        secret,
      }),
    },
  };
}

function provider(webhookSecret?: string) {
  return createHogsendEmailProvider({
    relayUrl: "https://cloud.hogsend.com",
    tenantToken: "hsrel_token",
    ...(webhookSecret ? { webhookSecret } : {}),
    fetch: vi.fn() as unknown as typeof fetch,
  });
}

/**
 * `verifyWebhook` MAY be sync or async per the contract, and a sync throw is
 * not a rejected promise. Going through an async wrapper asserts the same thing
 * for either shape.
 */
async function verify(
  p: ReturnType<typeof provider>,
  opts: { payload: string; headers: Record<string, string> },
) {
  return p.verifyWebhook(opts);
}

// ---------------------------------------------------------------------------
// The wire shape this PRD OWNS. PRD 05 produces against exactly this.
// ---------------------------------------------------------------------------

describe("HogsendRelayEmailEvent — the shape PRD 05 produces", () => {
  it("carries only the four provider-owned statuses", () => {
    // Opens and clicks are FIRST-PARTY and sovereign — they must never appear
    // on a provider wire, or the engine would have two disagreeing sources.
    expect([...HOGSEND_RELAY_EMAIL_EVENT_TYPES]).toEqual([
      "email.delivered",
      "email.bounced",
      "email.complained",
      "email.delivery_delayed",
    ]);
  });

  it("rejects an opened/clicked event", () => {
    for (const type of ["email.opened", "email.clicked", "email.sent"]) {
      expect(
        hogsendRelayEmailEventSchema.safeParse({ ...DELIVERED, type }).success,
      ).toBe(false);
    }
  });

  it("accepts a complete event and strips unknown keys", () => {
    const parsed = hogsendRelayEmailEventSchema.parse({
      ...DELIVERED,
      somethingNewer: "ignored",
    });
    expect(parsed).toEqual(DELIVERED);
  });

  it("requires the fields a complete EmailEvent needs", () => {
    for (const missing of [
      "version",
      "type",
      "messageId",
      "occurredAt",
      "recipients",
    ] as const) {
      const partial: Record<string, unknown> = { ...DELIVERED };
      delete partial[missing];
      expect(hogsendRelayEmailEventSchema.safeParse(partial).success).toBe(
        false,
      );
    }
  });

  it("pins the version so a future wire fails loudly instead of misparsing", () => {
    expect(HOGSEND_RELAY_EVENT_VERSION).toBe(1);
    expect(
      hogsendRelayEmailEventSchema.safeParse({ ...DELIVERED, version: 2 })
        .success,
    ).toBe(false);
  });

  it("rejects a non-ISO occurredAt", () => {
    expect(
      hogsendRelayEmailEventSchema.safeParse({
        ...DELIVERED,
        occurredAt: "yesterday",
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// verifyWebhook — FAIL CLOSED
// ---------------------------------------------------------------------------

describe("verifyWebhook fails closed", () => {
  it("rejects EVERY webhook when no secret is configured", async () => {
    const p = provider();
    const { payload, headers } = signed(DELIVERED);

    await expect(verify(p, { payload, headers })).rejects.toThrow(
      /webhook secret is not configured/i,
    );
  });

  it("does NOT parse the payload when no secret is configured", async () => {
    // The mutation check, baked in: this payload is not even JSON, and it is
    // not a relay event either. If the fail-closed guard were removed (or moved
    // below the parse), the thrown error would be the JSON/schema one rather
    // than the configuration one, and this assertion would fail.
    const p = provider();

    await expect(
      verify(p, {
        payload: "{ this is not json",
        headers: { [HOGSEND_RELAY_SIGNATURE_HEADER]: "sha256=deadbeef" },
      }),
    ).rejects.toThrow(/webhook secret is not configured/i);
  });

  it("rejects a missing signature header", async () => {
    const p = provider(SECRET);
    const { payload } = signed(DELIVERED);

    await expect(verify(p, { payload, headers: {} })).rejects.toThrow(
      /signature/i,
    );
  });

  it("rejects a signature made with the wrong secret", async () => {
    const p = provider(SECRET);
    const { payload, headers } = signed(DELIVERED, "whsec_wrong");

    await expect(verify(p, { payload, headers })).rejects.toThrow(/signature/i);
  });

  it("rejects a tampered payload signed for the original", async () => {
    const p = provider(SECRET);
    const { headers } = signed(DELIVERED);
    const tampered = JSON.stringify({
      ...DELIVERED,
      recipients: ["attacker@evil.test"],
    });

    await expect(verify(p, { payload: tampered, headers })).rejects.toThrow(
      /signature/i,
    );
  });

  it("rejects a wrong-length signature without throwing from the compare", async () => {
    const p = provider(SECRET);
    const { payload } = signed(DELIVERED);

    // `timingSafeEqual` THROWS on unequal buffer lengths — a length guard has
    // to come first, or a short signature becomes a 500 instead of a rejection.
    await expect(
      verify(p, {
        payload,
        headers: { [HOGSEND_RELAY_SIGNATURE_HEADER]: "sha256=ab" },
      }),
    ).rejects.toThrow(/signature/i);
  });

  it("accepts a valid signature and returns a normalized EmailEvent", async () => {
    const p = provider(SECRET);
    const { payload, headers } = signed(DELIVERED);

    const event = await p.verifyWebhook({ payload, headers });

    expect(event.type).toBe("email.delivered");
    expect(event.messageId).toBe("0100018f-ses-message-id");
    expect(event.recipients).toEqual(["user@example.com"]);
    expect(event.occurredAt).toBe("2026-08-10T09:30:00.000Z");
    expect(event.raw).toEqual(DELIVERED);
  });

  it("reads the signature header case-insensitively", async () => {
    const p = provider(SECRET);
    const payload = JSON.stringify(DELIVERED);
    const event = await verify(p, {
      payload,
      headers: {
        "X-Hogsend-Signature": signHogsendRelayWebhook({
          payload,
          secret: SECRET,
        }),
      },
    });
    expect(event.type).toBe("email.delivered");
  });

  it("accepts a bare hex signature as well as the sha256= form", async () => {
    const p = provider(SECRET);
    const payload = JSON.stringify(DELIVERED);
    const hex = createHmac("sha256", SECRET).update(payload).digest("hex");

    const event = await verify(p, {
      payload,
      headers: { [HOGSEND_RELAY_SIGNATURE_HEADER]: hex },
    });
    expect(event.type).toBe("email.delivered");
  });

  it("rejects a valid signature over a payload that is not a relay event", async () => {
    const p = provider(SECRET);
    const { payload, headers } = signed({ hello: "world" });

    await expect(verify(p, { payload, headers })).rejects.toThrow(
      /not a hogsend relay email event/i,
    );
  });
});

describe("signHogsendRelayWebhook", () => {
  it("is a plain HMAC-SHA256 hex digest over the raw payload", () => {
    const payload = JSON.stringify(DELIVERED);
    expect(signHogsendRelayWebhook({ payload, secret: SECRET })).toBe(
      `sha256=${createHmac("sha256", SECRET).update(payload).digest("hex")}`,
    );
  });
});

// ---------------------------------------------------------------------------
// Normalization into the core EmailEvent
// ---------------------------------------------------------------------------

describe("parseHogsendRelayWebhook → core EmailEvent", () => {
  it("maps a delivered event", () => {
    const event = parseHogsendRelayWebhook(JSON.stringify(DELIVERED));
    expect(event).toEqual({
      type: "email.delivered",
      messageId: "0100018f-ses-message-id",
      recipients: ["user@example.com"],
      occurredAt: "2026-08-10T09:30:00.000Z",
      raw: DELIVERED,
    });
    expect(event.bounce).toBeUndefined();
  });

  it("carries every recipient a bounce names", () => {
    const event = parseHogsendRelayWebhook(
      JSON.stringify({
        ...DELIVERED,
        type: "email.bounced",
        recipients: ["a@example.com", "b@example.com"],
        bounce: { type: "Permanent", subType: "General", reason: "550 5.1.1" },
      }),
    );
    expect(event.recipients).toEqual(["a@example.com", "b@example.com"]);
    expect(event.bounce).toEqual({
      class: "permanent",
      code: "Permanent/General",
      reason: "550 5.1.1",
    });
  });

  it("maps a transient bounce without suppressing", () => {
    const event = parseHogsendRelayWebhook(
      JSON.stringify({
        ...DELIVERED,
        type: "email.bounced",
        bounce: { type: "Transient", subType: "MailboxFull" },
      }),
    );
    expect(event.type).toBe("email.bounced");
    expect(event.bounce).toEqual({
      class: "transient",
      code: "Transient/MailboxFull",
    });
  });

  it("maps a complaint", () => {
    const event = parseHogsendRelayWebhook(
      JSON.stringify({
        ...DELIVERED,
        type: "email.complained",
        bounce: { type: "Complaint", subType: "abuse" },
      }),
    );
    expect(event.type).toBe("email.complained");
    expect(event.bounce?.class).toBe("complaint");
  });

  it("classifies a complaint even when the relay names no bounce block", () => {
    const event = parseHogsendRelayWebhook(
      JSON.stringify({ ...DELIVERED, type: "email.complained" }),
    );
    expect(event.bounce).toEqual({ class: "complaint", code: "Complaint" });
  });

  it("maps a delivery delay with NO bounce block", () => {
    const event = parseHogsendRelayWebhook(
      JSON.stringify({ ...DELIVERED, type: "email.delivery_delayed" }),
    );
    expect(event.type).toBe("email.delivery_delayed");
    // A delay is not a bounce — attaching one would drive suppression logic
    // off a message that may still be delivered.
    expect(event.bounce).toBeUndefined();
  });

  it("throws on a payload that is not a relay event", () => {
    expect(() => parseHogsendRelayWebhook('{"nope":true}')).toThrow(
      /not a hogsend relay email event/i,
    );
  });

  it("throws on a payload that is not JSON", () => {
    expect(() => parseHogsendRelayWebhook("{oops")).toThrow(
      /not a hogsend relay email event/i,
    );
  });
});

describe("classifyHogsendRelayBounce", () => {
  const cases: Array<[string, string]> = [
    ["Permanent", "permanent"],
    ["Transient", "transient"],
    ["Complaint", "complaint"],
    ["Undetermined", "unknown"],
    // Anything SES grows later defaults to `unknown`: recorded, never
    // suppressing. Guessing `permanent` here would silently kill deliverable
    // addresses.
    ["SomethingSesInventsIn2027", "unknown"],
    ["", "unknown"],
  ];

  for (const [type, expected] of cases) {
    it(`${type || "(empty)"} → ${expected}`, () => {
      expect(classifyHogsendRelayBounce(type)).toBe(expected);
    });
  }

  it("is case-insensitive on the SES bounce type", () => {
    expect(classifyHogsendRelayBounce("permanent")).toBe("permanent");
    expect(classifyHogsendRelayBounce("TRANSIENT")).toBe("transient");
  });
});
