import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  assertHogsendRelayFresh,
  classifyHogsendRelayBounce,
  createHogsendEmailProvider,
  HOGSEND_RELAY_EMAIL_EVENT_TYPES,
  HOGSEND_RELAY_EVENT_VERSION,
  HOGSEND_RELAY_MAX_AGE_MS,
  HOGSEND_RELAY_MAX_FUTURE_MS,
  HOGSEND_RELAY_SIGNATURE_HEADER,
  type HogsendEmailConfig,
  type HogsendRelayEmailEvent,
  hogsendRelayEmailEventSchema,
  parseHogsendRelayWebhook,
  signHogsendRelayWebhook,
  verifyHogsendRelaySignature,
} from "../index.js";

const SECRET = "whsec_hogsend_relay";

/**
 * RELATIVE to now, deliberately.
 *
 * `verifyWebhook` refuses a payload older than the configured skew, so a
 * hardcoded timestamp would silently become "stale" the day wall-clock time
 * passed it and turn this whole file red on a date rather than on a
 * regression. The freshness suite at the bottom pins the boundaries with an
 * injected clock instead.
 */
const OCCURRED_AT = new Date(Date.now() - 60_000).toISOString();

const DELIVERED: HogsendRelayEmailEvent = {
  version: HOGSEND_RELAY_EVENT_VERSION,
  type: "email.delivered",
  messageId: "0100018f-ses-message-id",
  recipients: ["user@example.com"],
  occurredAt: OCCURRED_AT,
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

function provider(
  webhookSecret?: string,
  overrides: Partial<HogsendEmailConfig> = {},
) {
  return createHogsendEmailProvider({
    relayUrl: "https://cloud.hogsend.com",
    tenantToken: "hsrel_token",
    ...(webhookSecret ? { webhookSecret } : {}),
    fetch: vi.fn() as unknown as typeof fetch,
    ...overrides,
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
  it("carries only the five provider-owned statuses", () => {
    // Opens and clicks are FIRST-PARTY and sovereign — they must never appear
    // on a provider wire, or the engine would have two disagreeing sources.
    // `email.rejected` (PRD 18) IS provider-owned: only SES knows it accepted
    // a message and then discarded it.
    expect([...HOGSEND_RELAY_EMAIL_EVENT_TYPES]).toEqual([
      "email.delivered",
      "email.bounced",
      "email.complained",
      "email.delivery_delayed",
      "email.rejected",
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

  it("accepts a reject carrying SES's reason verbatim", () => {
    const parsed = hogsendRelayEmailEventSchema.parse({
      ...DELIVERED,
      type: "email.rejected",
      reject: { reason: "Bad content" },
    });
    expect(parsed.type).toBe("email.rejected");
    expect(parsed.reject).toEqual({ reason: "Bad content" });
  });
});

// ---------------------------------------------------------------------------
// email.rejected — terminal, and structurally incapable of suppressing
// ---------------------------------------------------------------------------

describe("parseHogsendRelayWebhook — email.rejected (PRD 18)", () => {
  const REJECTED: HogsendRelayEmailEvent = {
    version: HOGSEND_RELAY_EVENT_VERSION,
    type: "email.rejected",
    messageId: "0100018f-ses-rejected-id",
    recipients: ["user@example.com"],
    occurredAt: OCCURRED_AT,
    reject: { reason: "Bad content" },
    raw: { eventType: "Reject" },
  };

  it("carries the reason verbatim onto the neutral EmailEvent", () => {
    const parsed = parseHogsendRelayWebhook(JSON.stringify(REJECTED));
    expect(parsed.type).toBe("email.rejected");
    expect(parsed.reject).toEqual({ reason: "Bad content" });
    expect(parsed.recipients).toEqual(["user@example.com"]);
  });

  it("attaches NO bounce block, so it cannot reach the suppression path", () => {
    // THE assertion. The engine suppresses off `bounce.class === "permanent"`,
    // so a reject that arrived carrying any bounce block would be one bad
    // attachment away from permanently blocking a deliverable address.
    const parsed = parseHogsendRelayWebhook(JSON.stringify(REJECTED));
    expect(parsed.bounce).toBeUndefined();
  });

  it("still attaches no bounce when a relay wrongly sends one", () => {
    // Belt and braces: the classification is driven by the EVENT TYPE, not by
    // the presence of the block, so a mis-populated wire cannot smuggle a
    // suppressing class through.
    const parsed = parseHogsendRelayWebhook(
      JSON.stringify({ ...REJECTED, bounce: { type: "Permanent" } }),
    );
    expect(parsed.bounce).toBeUndefined();
  });

  it("omits `reject` entirely on every other event type", () => {
    const parsed = parseHogsendRelayWebhook(JSON.stringify(DELIVERED));
    expect(parsed.reject).toBeUndefined();
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
    expect(event.occurredAt).toBe(OCCURRED_AT);
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
      occurredAt: OCCURRED_AT,
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

// ---------------------------------------------------------------------------
// Replay window — the timestamp is INSIDE the signed body, so it is bound by
// the HMAC and an attacker cannot move it. What it bounds is how long a
// CAPTURED payload stays replayable.
// ---------------------------------------------------------------------------

const NOW = Date.parse("2026-08-11T12:00:00.000Z");

/** A signed relay event whose `occurredAt` sits `ms` before {@link NOW}. */
function aged(ms: number) {
  return signed({
    ...DELIVERED,
    occurredAt: new Date(NOW - ms).toISOString(),
  });
}

function freshnessProvider(overrides: Partial<HogsendEmailConfig> = {}) {
  return provider(SECRET, { now: () => NOW, ...overrides });
}

describe("verifyWebhook rejects a stale payload", () => {
  it("defaults to a 24-hour window", () => {
    // HOURS, not minutes. See the note on HOGSEND_RELAY_MAX_AGE_MS: an SES
    // DeliveryDelay can legitimately arrive long after the instant it
    // describes, and a tight window turns that into a SILENTLY DROPPED bounce
    // — which is worse than a replay, because a replayed event is one the
    // engine already dedupes while a dropped one means suppression never
    // happens at all.
    expect(HOGSEND_RELAY_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
    expect(HOGSEND_RELAY_MAX_FUTURE_MS).toBe(5 * 60 * 1000);
  });

  it("accepts a payload just INSIDE the window", async () => {
    const p = freshnessProvider();
    const event = await verify(p, aged(HOGSEND_RELAY_MAX_AGE_MS - 1_000));
    expect(event.type).toBe("email.delivered");
  });

  it("accepts a payload exactly AT the window edge", async () => {
    const p = freshnessProvider();
    await expect(
      verify(p, aged(HOGSEND_RELAY_MAX_AGE_MS)),
    ).resolves.toBeDefined();
  });

  it("rejects a payload just OUTSIDE the window", async () => {
    const p = freshnessProvider();
    await expect(
      verify(p, aged(HOGSEND_RELAY_MAX_AGE_MS + 1_000)),
    ).rejects.toThrow(/too old/i);
  });

  it("rejects a week-old captured payload even though its signature is valid", async () => {
    // THE attack this closes: a payload captured off the wire replays forever
    // while the environment's webhook secret is unchanged, and every replay
    // re-runs the engine's bounce counter toward suppression.
    const p = freshnessProvider();
    const week = aged(7 * 24 * 60 * 60 * 1000);
    // The signature itself is still perfectly good — freshness is the only
    // thing refusing it.
    expect(
      verifyHogsendRelaySignature({
        payload: week.payload,
        secret: SECRET,
        signature: week.headers[HOGSEND_RELAY_SIGNATURE_HEADER] as string,
      }),
    ).toBe(true);
    await expect(verify(p, week)).rejects.toThrow(/too old/i);
  });

  it("honours a configured window", async () => {
    const p = freshnessProvider({ webhookMaxAgeMs: 60_000 });
    await expect(verify(p, aged(30_000))).resolves.toBeDefined();
    await expect(verify(p, aged(90_000))).rejects.toThrow(/too old/i);
  });

  it("rejects a timestamp far in the FUTURE", async () => {
    // Not because an attacker can forge one — the HMAC prevents that — but
    // because a clock bug on OUR side would mint a payload that stays
    // replayable effectively forever.
    const p = freshnessProvider();
    await expect(
      verify(p, aged(-(HOGSEND_RELAY_MAX_FUTURE_MS + 60_000))),
    ).rejects.toThrow(/future/i);
  });

  it("tolerates a small clock skew ahead", async () => {
    const p = freshnessProvider();
    await expect(
      verify(p, aged(-(HOGSEND_RELAY_MAX_FUTURE_MS - 1_000))),
    ).resolves.toBeDefined();
  });

  it("checks the signature BEFORE it reads the timestamp", async () => {
    // Never trust a value out of a payload whose signature has not been
    // checked. A stale payload with a BAD signature must be refused as a
    // signature failure, not as a stale one.
    const p = freshnessProvider();
    const stale = aged(7 * 24 * 60 * 60 * 1000);
    await expect(
      verify(p, {
        payload: stale.payload,
        headers: { [HOGSEND_RELAY_SIGNATURE_HEADER]: "sha256=deadbeef" },
      }),
    ).rejects.toThrow(/signature/i);
  });

  it("leaves parseWebhook alone — it is the unverified path", async () => {
    // `parseWebhook` exists for a caller that verified elsewhere. Freshness is
    // an ANTI-REPLAY control, and a replay is only meaningful for a payload
    // that authenticated, so the check belongs with verification.
    const p = freshnessProvider();
    const week = aged(7 * 24 * 60 * 60 * 1000);
    expect(p.parseWebhook(week.payload).type).toBe("email.delivered");
  });
});

describe("assertHogsendRelayFresh", () => {
  it("fails CLOSED on a timestamp it cannot parse", () => {
    // The schema's `.datetime()` is the first line and would normally catch
    // this; the guard is here so the two cannot drift into a gap where an
    // unparseable timestamp means "no timestamp, allow".
    expect(() =>
      assertHogsendRelayFresh({ occurredAt: "yesterday", now: NOW }),
    ).toThrow(/could not be read/i);
    expect(() => assertHogsendRelayFresh({ occurredAt: "", now: NOW })).toThrow(
      /could not be read/i,
    );
  });

  it("says how old the payload was, so an operator can widen the window", () => {
    expect(() =>
      assertHogsendRelayFresh({
        occurredAt: new Date(NOW - 50 * 60 * 60 * 1000).toISOString(),
        now: NOW,
      }),
    ).toThrow(/50h/);
  });
});
