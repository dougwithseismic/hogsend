import type { DnsRecord } from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";
import { applyRecords, canAutoApply } from "../lib/dns-apply.js";

/** Mocked fetch — NEVER hits the real Cloudflare/Vercel APIs. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const RECORDS: DnsRecord[] = [
  {
    type: "TXT",
    name: "resend._domainkey.mysite.com",
    value: "p=MIGfMA0GCSq",
    purpose: "dkim",
    status: "pending",
  },
  {
    type: "MX",
    name: "send.mysite.com",
    value: "feedback-smtp.us-east-1.amazonses.com",
    priority: 10,
    purpose: "spf",
    status: "pending",
  },
];

describe("canAutoApply", () => {
  it("cloudflare requires CLOUDFLARE_API_TOKEN", () => {
    expect(canAutoApply("cloudflare", { CLOUDFLARE_API_TOKEN: "t" })).toBe(
      true,
    );
    expect(canAutoApply("cloudflare", {})).toBe(false);
  });

  it("vercel requires VERCEL_TOKEN", () => {
    expect(canAutoApply("vercel", { VERCEL_TOKEN: "t" })).toBe(true);
    expect(canAutoApply("vercel", {})).toBe(false);
  });

  it("every other host is false even with creds set", () => {
    for (const host of [
      "route53",
      "godaddy",
      "namecheap",
      "porkbun",
      "google",
      "unknown",
    ] as const) {
      expect(
        canAutoApply(host, { CLOUDFLARE_API_TOKEN: "t", VERCEL_TOKEN: "t" }),
      ).toBe(false);
    }
  });
});

describe("applyRecords — cloudflare", () => {
  it("resolves the zone then POSTs each record with proxied:false", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "zone1" }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }));

    const result = await applyRecords({
      host: "cloudflare",
      domain: "mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });

    expect(result.applied).toHaveLength(2);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(0);

    const [zoneUrl, zoneInit] = fetchImpl.mock.calls[0] as [
      string,
      RequestInit,
    ];
    expect(zoneUrl).toBe(
      "https://api.cloudflare.com/client/v4/zones?name=mysite.com",
    );
    expect((zoneInit.headers as Record<string, string>).Authorization).toBe(
      "Bearer cf_token",
    );

    const [recUrl, recInit] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(recUrl).toBe(
      "https://api.cloudflare.com/client/v4/zones/zone1/dns_records",
    );
    const payload = JSON.parse(recInit.body as string);
    expect(payload.proxied).toBe(false);
    expect(payload.type).toBe("TXT");
    expect(payload.name).toBe("resend._domainkey.mysite.com");

    // MX priority threaded through.
    const mxPayload = JSON.parse(
      (fetchImpl.mock.calls[2] as [string, RequestInit])[1].body as string,
    );
    expect(mxPayload.priority).toBe(10);
  });

  it("counts an identical-record-exists error (81057) as skipped", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "zone1" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          {
            success: false,
            errors: [{ code: 81057, message: "Record already exists." }],
          },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }));

    const result = await applyRecords({
      host: "cloudflare",
      domain: "mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it("collects other API failures into errors (never throws)", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "zone1" }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { success: false, errors: [{ code: 9999, message: "API boom" }] },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ success: true, result: {} }));

    const result = await applyRecords({
      host: "cloudflare",
      domain: "mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("API boom");
    expect(result.applied).toHaveLength(1);
  });

  it("errors out cleanly when the zone cannot be resolved", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ success: true, result: [] }));

    const result = await applyRecords({
      host: "cloudflare",
      domain: "mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });

    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("zone");
  });

  it("resolves the zone by the registrable domain for subdomains", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ success: true, result: [{ id: "zone1" }] }),
      )
      .mockResolvedValue(jsonResponse({ success: true, result: {} }));

    await applyRecords({
      host: "cloudflare",
      domain: "mail.mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });

    const [zoneUrl] = fetchImpl.mock.calls[0] as [string];
    expect(zoneUrl).toContain("name=mysite.com");
  });
});

describe("applyRecords — vercel", () => {
  it("POSTs each record to the domains records API", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uid: "rec_1" }));

    const result = await applyRecords({
      host: "vercel",
      domain: "mysite.com",
      records: RECORDS,
      env: { VERCEL_TOKEN: "v_token" },
      fetchImpl,
    });

    expect(result.applied).toHaveLength(2);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.vercel.com/v2/domains/mysite.com/records");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer v_token",
    );
    const payload = JSON.parse(init.body as string);
    expect(payload.type).toBe("TXT");
  });

  it("appends ?teamId= when VERCEL_TEAM_ID is set", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ uid: "rec_1" }));

    await applyRecords({
      host: "vercel",
      domain: "mysite.com",
      records: RECORDS.slice(0, 1),
      env: { VERCEL_TOKEN: "v_token", VERCEL_TEAM_ID: "team_1" },
      fetchImpl,
    });

    const [url] = fetchImpl.mock.calls[0] as [string];
    expect(url).toContain("?teamId=team_1");
  });

  it("counts a duplicate-record error as skipped", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            error: {
              code: "duplicate_record",
              message: "A record already exists",
            },
          },
          400,
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ uid: "rec_2" }));

    const result = await applyRecords({
      host: "vercel",
      domain: "mysite.com",
      records: RECORDS,
      env: { VERCEL_TOKEN: "v_token" },
      fetchImpl,
    });

    expect(result.skipped).toHaveLength(1);
    expect(result.applied).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });
});

describe("applyRecords — unsupported host / missing creds", () => {
  it("returns everything skipped with an explanatory error", async () => {
    const result = await applyRecords({
      host: "godaddy",
      domain: "mysite.com",
      records: RECORDS,
      env: {},
    });
    expect(result.applied).toHaveLength(0);
    expect(result.skipped).toHaveLength(2);
    expect(result.errors).toHaveLength(1);
  });

  it("never throws on a transport failure", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await applyRecords({
      host: "cloudflare",
      domain: "mysite.com",
      records: RECORDS,
      env: { CLOUDFLARE_API_TOKEN: "cf_token" },
      fetchImpl,
    });
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
