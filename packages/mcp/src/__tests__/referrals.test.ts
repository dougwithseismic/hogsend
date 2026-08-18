/**
 * The two read-only referral tools: the query they send, the shape they hand
 * back, and the error mapping. Both are GETs, so there is no write path to
 * pin. What matters is that the parameters reach the admin route verbatim.
 */
import { describe, expect, it } from "vitest";
import {
  createReferralReportTool,
  createReferralTreeTool,
} from "../tools/referrals.js";
import { httpError, makeClient } from "./helpers.js";

describe("get_referral_report", () => {
  it("forwards the model, window, depth and weights and returns the report", async () => {
    const { client, calls } = makeClient({
      get: () => ({
        referral: "invite",
        model: "linear",
        beneficiaries: [{ contactId: "c1", value: [] }],
      }),
    });
    const tool = createReferralReportTool(client);

    const result = (await tool.handler({
      referral: "invite",
      model: "linear",
      window: "90d",
      depth: 3,
      weights: "1,0.5,0.25",
    })) as { ok: boolean; referral: string };

    expect(result.ok).toBe(true);
    expect(result.referral).toBe("invite");
    expect(calls[0]?.path).toBe("/v1/admin/referrals");
    expect(calls[0]?.query).toEqual({
      referral: "invite",
      model: "linear",
      window: "90d",
      depth: 3,
      weights: "1,0.5,0.25",
    });
  });

  it("rejects an unknown model without calling the API", async () => {
    const { client, calls } = makeClient({});
    const tool = createReferralReportTool(client);

    const result = (await tool.handler({ model: "made_up" })) as {
      ok: boolean;
      code: string;
    };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });

  it("maps a 403 to forbidden", async () => {
    const { client } = makeClient({
      get: () => {
        throw httpError(403, { error: "Forbidden" });
      },
    });
    const tool = createReferralReportTool(client);

    const result = (await tool.handler({})) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("forbidden");
  });
});

describe("get_referral_tree", () => {
  it("puts the contact id in the path and the rest in the query", async () => {
    const { client, calls } = makeClient({
      get: () => ({ contactId: "c1", nodes: [], touches: [] }),
    });
    const tool = createReferralTreeTool(client);

    const result = (await tool.handler({
      contactId: "c 1",
      depth: 2,
      limit: 10,
    })) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(calls[0]?.path).toBe("/v1/admin/referrals/c%201");
    expect(calls[0]?.query).toEqual({ depth: 2, limit: 10 });
  });

  it("requires a contact id", async () => {
    const { client, calls } = makeClient({});
    const tool = createReferralTreeTool(client);

    const result = (await tool.handler({})) as { ok: boolean; code: string };

    expect(result.ok).toBe(false);
    expect(result.code).toBe("invalid_input");
    expect(calls).toHaveLength(0);
  });
});
