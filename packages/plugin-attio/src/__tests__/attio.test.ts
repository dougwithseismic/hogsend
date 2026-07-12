import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createAttioProvider } from "../index.js";

const SECRET = "attio-secret";

const WEBHOOK_BODY = JSON.stringify({
  webhook_id: "wh-1",
  events: [
    {
      event_type: "record.updated",
      id: { workspace_id: "ws", object_id: "deals-obj", record_id: "rec-1" },
      occurred_at: "2026-07-12T11:00:00.000Z",
    },
  ],
});

const DEAL_RECORD = {
  data: {
    values: {
      stage: [
        {
          status: {
            id: { status_id: "status-sold" },
            title: "Sold",
          },
        },
      ],
      value: [{ currency_value: 14500, currency_code: "GBP" }],
      associated_people: [{ target_record_id: "person-1" }],
    },
  },
};

const PERSON_RECORD = {
  data: {
    values: {
      email_addresses: [{ email_address: "buyer@example.com" }],
    },
  },
};

function sig(body: string): string {
  return createHmac("sha256", SECRET).update(body).digest("hex");
}

function mockFetch() {
  return vi.fn(async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("/objects/deals/records/rec-1")) {
      return new Response(JSON.stringify(DEAL_RECORD), { status: 200 });
    }
    if (u.includes("/objects/people/records/person-1")) {
      return new Response(JSON.stringify(PERSON_RECORD), { status: 200 });
    }
    if (u.includes("matching_attribute=email_addresses")) {
      return new Response(
        JSON.stringify({ data: { id: { record_id: "person-9" } } }),
        { status: 200 },
      );
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function provider(fetchImpl = mockFetch()) {
  return createAttioProvider({
    apiKey: "key",
    webhookSecret: SECRET,
    fetch: fetchImpl,
  });
}

describe("createAttioProvider", () => {
  it("rejects a bad signature", async () => {
    await expect(
      provider().verifyWebhook({
        payload: WEBHOOK_BODY,
        headers: { "attio-signature": "nope" },
        url: "https://x",
      }),
    ).rejects.toThrow(/signature/);
  });

  it("verifies + hydrates a thin record.updated into a valued stage event with the contact email", async () => {
    const events = await provider().verifyWebhook({
      payload: WEBHOOK_BODY,
      headers: { "attio-signature": sig(WEBHOOK_BODY) },
      url: "https://x",
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      dealId: "rec-1",
      contactId: "person-1",
      email: "buyer@example.com",
      stageId: "status-sold",
      stageName: "Sold",
      value: { amount: 14500, currency: "GBP" },
      occurredAt: "2026-07-12T11:00:00.000Z",
    });
  });

  it("hydrate reads current stage + value for a deal", async () => {
    const hydrated = await provider().hydrate?.("rec-1");
    expect(hydrated).toMatchObject({
      stageId: "status-sold",
      value: { amount: 14500, currency: "GBP" },
    });
  });

  it("pushLead asserts the person by email (idempotent upsert)", async () => {
    const result = await provider().pushLead(
      { email: "new@example.com", name: "New Lead" },
      { idempotencyKey: "k" },
    );
    expect(result).toEqual({ contactId: "person-9" });
  });
});
