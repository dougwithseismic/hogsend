import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createResendDomains } from "../domains.js";

/**
 * Mocked-fetch fixtures for the Resend Domains REST API. NEVER hits the real
 * service — every test stubs `globalThis.fetch`.
 */

const DOMAIN_ID = "d91cd9bd-1176-453e-8fc1-35364d380206";

const DOMAIN_DETAIL = {
  object: "domain",
  id: DOMAIN_ID,
  name: "mysite.com",
  status: "not_started",
  created_at: "2026-06-09T00:00:00.000Z",
  region: "us-east-1",
  records: [
    {
      record: "SPF",
      name: "send",
      type: "MX",
      ttl: "Auto",
      status: "not_started",
      value: "feedback-smtp.us-east-1.amazonses.com",
      priority: 10,
    },
    {
      record: "SPF",
      name: "send",
      type: "TXT",
      ttl: "Auto",
      status: "pending",
      value: "v=spf1 include:amazonses.com ~all",
    },
    {
      record: "DKIM",
      name: "resend._domainkey",
      type: "TXT",
      ttl: "Auto",
      status: "verified",
      value: "p=MIGfMA0GCSqGSIb3...",
    },
    {
      record: "DKIM",
      name: "broken._domainkey",
      type: "TXT",
      ttl: "Auto",
      status: "failure",
      value: "p=BROKEN",
    },
  ],
};

const DOMAIN_LIST = {
  data: [
    { id: DOMAIN_ID, name: "mysite.com", status: "not_started" },
    { id: "other-id", name: "other.com", status: "verified" },
  ],
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const domains = createResendDomains({ apiKey: "re_test_key" });

describe("createResendDomains — create", () => {
  it("POSTs /domains with the bearer token and normalizes the response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL, 201));

    const status = await domains.create("mysite.com");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/domains");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer re_test_key",
    );
    expect(JSON.parse(init.body as string)).toEqual({ name: "mysite.com" });

    expect(status.domain).toBe("mysite.com");
    expect(status.providerId).toBe("resend");
    expect(status.state).toBe("pending"); // not_started → pending
    expect(status.raw).toEqual(DOMAIN_DETAIL);
    expect(typeof status.checkedAt).toBe("string");
  });

  it("falls through to lookup when the domain already exists (idempotent)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          {
            statusCode: 409,
            name: "conflict",
            message: "Domain already exists",
          },
          409,
        ),
      )
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));

    const status = await domains.create("mysite.com");
    expect(status.domain).toBe("mysite.com");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("throws on other API errors", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ statusCode: 401, message: "API key is invalid" }, 401),
    );
    await expect(domains.create("mysite.com")).rejects.toThrow(
      /API key is invalid/,
    );
  });
});

describe("createResendDomains — get", () => {
  it("resolves name → id via the list, then normalizes the detail", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));

    const status = await domains.get("mysite.com");
    expect(status).not.toBeNull();
    expect(status?.domain).toBe("mysite.com");

    // The detail GET hit /domains/:id.
    const [detailUrl] = fetchMock.mock.calls[1] as [string];
    expect(detailUrl).toBe(`https://api.resend.com/domains/${DOMAIN_ID}`);
  });

  it("returns null when the provider doesn't know the domain", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_LIST));
    const status = await domains.get("unknown.com");
    expect(status).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("normalizes records: purpose + status mapping table", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));

    const status = await domains.get("mysite.com");
    const records = status?.records ?? [];
    expect(records).toHaveLength(4);

    // SPF + MX type → purpose spf (record kind wins), priority preserved.
    expect(records[0]).toMatchObject({
      type: "MX",
      name: "send",
      purpose: "spf",
      priority: 10,
      status: "pending", // not_started → pending
    });
    // SPF TXT.
    expect(records[1]).toMatchObject({
      type: "TXT",
      purpose: "spf",
      status: "pending",
    });
    // DKIM verified.
    expect(records[2]).toMatchObject({
      name: "resend._domainkey",
      purpose: "dkim",
      status: "verified",
    });
    // DKIM failure → failed.
    expect(records[3]).toMatchObject({ purpose: "dkim", status: "failed" });
  });

  it("maps domain status → DomainVerificationState", async () => {
    for (const [provider, expected] of [
      ["verified", "verified"],
      ["failure", "failed"],
      ["pending", "pending"],
      ["temporary_failure", "pending"],
      ["not_started", "pending"],
    ] as const) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
        .mockResolvedValueOnce(
          jsonResponse({ ...DOMAIN_DETAIL, status: provider }),
        );
      const status = await domains.get("mysite.com");
      expect(status?.state).toBe(expected);
    }
  });
});

describe("createResendDomains — records", () => {
  it("returns the normalized record list", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));
    const records = await domains.records("mysite.com");
    expect(records).toHaveLength(4);
  });

  it("returns [] for an unknown domain", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_LIST));
    const records = await domains.records("unknown.com");
    expect(records).toEqual([]);
  });
});

describe("createResendDomains — verify", () => {
  it("POSTs /domains/:id/verify then re-fetches the status", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse({ object: "domain", id: DOMAIN_ID }))
      .mockResolvedValueOnce(
        jsonResponse({ ...DOMAIN_DETAIL, status: "verified" }),
      );

    // biome-ignore lint/style/noNonNullAssertion: verify is implemented for Resend
    const status = await domains.verify!("mysite.com");

    const [verifyUrl, verifyInit] = fetchMock.mock.calls[1] as [
      string,
      RequestInit,
    ];
    expect(verifyUrl).toBe(
      `https://api.resend.com/domains/${DOMAIN_ID}/verify`,
    );
    expect(verifyInit.method).toBe("POST");
    expect(status.state).toBe("verified");
  });

  it("throws when the domain is unknown", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_LIST));
    // biome-ignore lint/style/noNonNullAssertion: verify is implemented for Resend
    await expect(domains.verify!("unknown.com")).rejects.toThrow(
      /not registered/,
    );
  });
});
