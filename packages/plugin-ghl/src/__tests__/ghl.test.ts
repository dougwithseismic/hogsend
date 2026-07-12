import { describe, expect, it, vi } from "vitest";
import { createGhlProvider } from "../index.js";

const WEBHOOK = JSON.stringify({
  id: "opp-1",
  contact_id: "con-1",
  email: "lead@example.com",
  pipelineId: "pipe-1",
  pipelineStageId: "stage-sold",
  pipelineStageName: "Sold",
  status: "won",
  monetaryValue: 17124,
  dateUpdated: "2026-07-12T10:31:11.000Z",
});

function provider(fetchImpl?: typeof fetch) {
  return createGhlProvider({
    accessToken: "pit-token",
    locationId: "loc-1",
    webhookSecret: "shhh",
    defaultPipelineId: "pipe-1",
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
}

describe("createGhlProvider", () => {
  it("parses an opportunity webhook into a valued CrmStageEvent", () => {
    const [event] = provider().parseWebhook(WEBHOOK);
    expect(event).toMatchObject({
      dealId: "opp-1",
      contactId: "con-1",
      email: "lead@example.com",
      pipelineId: "pipe-1",
      stageId: "stage-sold",
      stageName: "Sold",
      status: "won",
      value: { amount: 17124 },
      occurredAt: "2026-07-12T10:31:11.000Z",
    });
  });

  it("tolerates GHL's shipped pipleineId typo and string monetaryValue", () => {
    const [event] = provider().parseWebhook(
      JSON.stringify({
        id: "opp-2",
        pipleineId: "pipe-x",
        pipelineStageId: "s1",
        monetaryValue: "950.50",
        dateAdded: "2026-07-12T09:00:00.000Z",
      }),
    );
    expect(event?.pipelineId).toBe("pipe-x");
    expect(event?.value).toEqual({ amount: 950.5 });
  });

  it("verifyWebhook fails closed: wrong/missing secret throws, query or header secret passes", async () => {
    const p = provider();
    expect(() =>
      p.verifyWebhook({ payload: WEBHOOK, headers: {}, url: "https://x/y" }),
    ).toThrow(/secret/);
    expect(
      await p.verifyWebhook({
        payload: WEBHOOK,
        headers: { "x-ghl-secret": "shhh" },
        url: "https://x/y",
      }),
    ).toHaveLength(1);
    expect(
      await p.verifyWebhook({
        payload: WEBHOOK,
        headers: {},
        url: "https://x/y?secret=shhh",
      }),
    ).toHaveLength(1);
  });

  it("pushLead upserts the contact then creates the opportunity", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const fetchImpl = vi.fn(
      async (url: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
          url: String(url),
          body: init?.body ? JSON.parse(String(init.body)) : undefined,
        });
        const body = String(url).includes("/contacts/upsert")
          ? { contact: { id: "con-9" } }
          : { opportunity: { id: "opp-9" } };
        return new Response(JSON.stringify(body), { status: 200 });
      },
    ) as unknown as typeof fetch;

    const result = await provider(fetchImpl).pushLead(
      {
        email: "lead@example.com",
        name: "Jane",
        value: { amount: 12000, currency: "GBP" },
      },
      { idempotencyKey: "lead-1" },
    );
    expect(result).toEqual({ contactId: "con-9", dealId: "opp-9" });
    expect(calls[0]?.url).toContain("/contacts/upsert");
    expect(calls[0]?.body).toMatchObject({
      locationId: "loc-1",
      email: "lead@example.com",
    });
    expect(calls[1]?.url).toContain("/opportunities/");
    expect(calls[1]?.body).toMatchObject({
      contactId: "con-9",
      pipelineId: "pipe-1",
      monetaryValue: 12000,
    });
  });

  it("poll filters at the cursor and returns the newest dateUpdated as nextCursor", async () => {
    const fetchImpl = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          opportunities: [
            {
              id: "a",
              pipelineStageId: "s",
              dateUpdated: "2026-07-12T10:00:00.000Z",
            },
            {
              id: "b",
              pipelineStageId: "s",
              dateUpdated: "2026-07-12T12:00:00.000Z",
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const p = provider(fetchImpl);
    const result = await p.poll?.("2026-07-12T10:00:00.000Z");
    expect(result?.events.map((e) => e.dealId)).toEqual(["b"]);
    expect(result?.nextCursor).toBe("2026-07-12T12:00:00.000Z");
  });
});
