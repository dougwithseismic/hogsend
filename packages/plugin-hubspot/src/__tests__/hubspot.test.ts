import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHubspotProvider } from "../index.js";

const NOW = 1783900000000;
const URL_POSTED = "https://api.example.com/v1/webhooks/crm/hubspot";

const WEBHOOK = JSON.stringify([
  {
    objectId: 987,
    subscriptionType: "deal.propertyChange",
    propertyName: "dealstage",
    propertyValue: "closedwon",
    occurredAt: 1783899990000,
  },
  {
    objectId: 987,
    subscriptionType: "deal.propertyChange",
    propertyName: "amount",
    propertyValue: "9500",
    occurredAt: 1783899990001,
  },
]);

const DEAL = {
  properties: {
    dealstage: "closedwon",
    pipeline: "default",
    amount: "9500",
    deal_currency_code: "GBP",
    hs_is_closed_won: "true",
  },
  associations: { contacts: { results: [{ id: "301" }] } },
};

function mockFetch() {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/objects/deals/987")) {
      return new Response(JSON.stringify(DEAL), { status: 200 });
    }
    if (u.includes("/objects/contacts/301")) {
      return new Response(
        JSON.stringify({ properties: { email: "won@example.com" } }),
        { status: 200 },
      );
    }
    if (u.includes("/objects/contacts/search")) {
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    if (u.includes("/objects/contacts") && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "new-1" }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
}

function v3Signature(secret: string, payload: string, ts: number): string {
  return createHmac("sha256", secret)
    .update(`POST${URL_POSTED}${payload}${ts}`)
    .digest("base64");
}

describe("createHubspotProvider", () => {
  it("verifies the v3 signature and hydrates dealstage changes into ONE valued event per deal", async () => {
    const provider = createHubspotProvider({
      accessToken: "pat",
      clientSecret: "cs",
      fetch: mockFetch(),
      now: () => NOW,
    });
    const events = await provider.verifyWebhook({
      payload: WEBHOOK,
      headers: {
        "x-hubspot-signature-v3": v3Signature("cs", WEBHOOK, NOW - 1000),
        "x-hubspot-request-timestamp": String(NOW - 1000),
      },
      url: URL_POSTED,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      dealId: "987",
      contactId: "301",
      email: "won@example.com",
      pipelineId: "default",
      stageId: "closedwon",
      status: "won",
      value: { amount: 9500, currency: "GBP" },
    });
  });

  it("rejects stale timestamps and bad signatures; requires SOME verification config", async () => {
    const provider = createHubspotProvider({
      accessToken: "pat",
      clientSecret: "cs",
      fetch: mockFetch(),
      now: () => NOW,
    });
    await expect(
      provider.verifyWebhook({
        payload: WEBHOOK,
        headers: {
          "x-hubspot-signature-v3": v3Signature("cs", WEBHOOK, NOW - 600000),
          "x-hubspot-request-timestamp": String(NOW - 600000),
        },
        url: URL_POSTED,
      }),
    ).rejects.toThrow(/timestamp/);

    const unconfigured = createHubspotProvider({
      accessToken: "pat",
      fetch: mockFetch(),
    });
    await expect(
      unconfigured.verifyWebhook({
        payload: WEBHOOK,
        headers: {},
        url: URL_POSTED,
      }),
    ).rejects.toThrow(/unconfigured/);
  });

  it("shared-secret fallback verifies workflow webhooks", async () => {
    const provider = createHubspotProvider({
      accessToken: "pat",
      webhookSecret: "ws",
      fetch: mockFetch(),
    });
    const events = await provider.verifyWebhook({
      payload: WEBHOOK,
      headers: {},
      url: `${URL_POSTED}?secret=ws`,
    });
    expect(events).toHaveLength(1);
  });

  it("pushLead searches before creating (no atomic upsert on v3)", async () => {
    const provider = createHubspotProvider({
      accessToken: "pat",
      webhookSecret: "ws",
      fetch: mockFetch(),
    });
    const result = await provider.pushLead(
      { email: "new@example.com", name: "New" },
      { idempotencyKey: "k" },
    );
    expect(result).toEqual({ contactId: "new-1" });
  });

  it("poll maps search results to valued events with an advancing cursor", async () => {
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes("/objects/deals/search")) {
        return new Response(
          JSON.stringify({
            results: [
              {
                id: "1",
                properties: {
                  dealstage: "quote",
                  amount: "100",
                  hs_lastmodifieddate: "2026-07-12T10:00:00.000Z",
                },
              },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const provider = createHubspotProvider({
      accessToken: "pat",
      webhookSecret: "ws",
      fetch: fetchImpl,
    });
    const result = await provider.poll?.("2026-07-12T09:00:00.000Z");
    expect(result?.events).toHaveLength(1);
    expect(result?.events[0]?.value).toEqual({ amount: 100 });
    expect(result?.nextCursor).toBe("2026-07-12T10:00:00.000Z");
  });
});
