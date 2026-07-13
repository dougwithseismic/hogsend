import { createHash } from "node:crypto";
import type { ConversionDispatchInput } from "@hogsend/core";
import { describe, expect, it, vi } from "vitest";
import {
  buildMetaEvent,
  createMetaCapiDestination,
  hashEmail,
  hashPhone,
  reconstructFbc,
} from "../index.js";

const INPUT: ConversionDispatchInput = {
  eventId: "a".repeat(64),
  definitionId: "solar-sale",
  triggerEvent: "deal.sold",
  value: 17124,
  currency: "GBP",
  occurredAt: 1783891871000,
  contact: {
    email: "  Buyer@Example.COM ",
    phone: "+44 7700 900123",
    externalId: "user-1",
  },
  clicks: {
    clickIds: { fbclid: "FBCLID_XYZ" },
    clickAt: 1783700000000,
    landingPage: "https://x.com/quote",
  },
};

describe("meta-capi payload", () => {
  it("hashes identifiers per Meta normalization; fbc rides plain", () => {
    expect(hashEmail("  Buyer@Example.COM ")).toBe(
      createHash("sha256").update("buyer@example.com").digest("hex"),
    );
    expect(hashPhone("+44 7700 900123")).toBe(
      createHash("sha256").update("447700900123").digest("hex"),
    );
    expect(reconstructFbc(INPUT.clicks)).toBe("fb.1.1783700000000.FBCLID_XYZ");
    // No real Meta click → NEVER fabricate fbc.
    expect(reconstructFbc({ clickIds: { gclid: "g" }, clickAt: 1 })).toBeNull();
    expect(reconstructFbc({ clickIds: { fbclid: "f" } })).toBeNull();
  });

  it("builds a system_generated event with dedup id, value, and epoch seconds", () => {
    const event = buildMetaEvent(INPUT, {});
    expect(event).toMatchObject({
      event_name: "Purchase",
      event_time: 1783891871,
      event_id: "a".repeat(64),
      action_source: "system_generated",
      custom_data: {
        value: 17124,
        currency: "GBP",
        trigger_event: "deal.sold",
      },
    });
    const userData = event.user_data as Record<string, unknown>;
    expect(userData.fbc).toBe("fb.1.1783700000000.FBCLID_XYZ");
    expect(Array.isArray(userData.em)).toBe(true);
  });

  it("event naming: per-definition override beats defaults; value-less falls back to Lead", () => {
    expect(
      buildMetaEvent(INPUT, { eventNames: { "solar-sale": "DealWon" } })
        .event_name,
    ).toBe("DealWon");
    expect(
      buildMetaEvent({ ...INPUT, value: null, currency: null }, {}).event_name,
    ).toBe("Lead");
  });

  it("send posts to /{version}/{pixel}/events and throws on a Graph error (retryable)", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    let fail = true;
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        if (fail) {
          fail = false;
          return new Response(
            JSON.stringify({ error: { message: "Invalid parameter" } }),
            { status: 400 },
          );
        }
        return new Response(
          JSON.stringify({ events_received: 1, fbtrace_id: "trace-1" }),
          { status: 200 },
        );
      },
    ) as unknown as typeof fetch;

    const destination = createMetaCapiDestination({
      pixelId: "123",
      accessToken: "tok",
      testEventCode: "TEST99",
      fetch: fetchImpl,
    });

    await expect(destination.send(INPUT)).rejects.toThrow(/Invalid parameter/);
    const result = await destination.send(INPUT);
    expect(result.response).toEqual({
      events_received: 1,
      fbtrace_id: "trace-1",
    });
    expect(calls[0]?.url).toBe("https://graph.facebook.com/v21.0/123/events");
    expect(calls[0]?.body).toMatchObject({
      access_token: "tok",
      test_event_code: "TEST99",
    });
    // The retry reuses the SAME event_id — platform-side dedup.
    const first = (calls[0]?.body.data as Array<Record<string, unknown>>)[0];
    const second = (calls[1]?.body.data as Array<Record<string, unknown>>)[0];
    expect(first?.event_id).toBe(second?.event_id);
  });
});
