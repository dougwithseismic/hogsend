import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mocked-fetch fixtures for Postmark's account-token Domains API. NEVER hits
 * the real service — every test stubs `globalThis.fetch`. The send wire's
 * ServerClient is mocked too so `createPostmarkProvider` never opens a socket.
 */

vi.mock("postmark", async () => {
  const actual = await vi.importActual<typeof import("postmark")>("postmark");
  class MockServerClient {
    sendEmail = vi.fn();
    sendEmailBatch = vi.fn();
  }
  return { ...actual, ServerClient: MockServerClient };
});

const { createPostmarkProvider } = await import("../index.js");

const DOMAIN_ID = 1234;

const DOMAIN_DETAIL = {
  ID: DOMAIN_ID,
  Name: "mysite.com",
  SPFVerified: true,
  DKIMVerified: false,
  WeakDKIM: false,
  DKIMHost: "",
  DKIMTextValue: "",
  DKIMPendingHost: "20260609._domainkey.mysite.com",
  DKIMPendingTextValue: "k=rsa; p=MIGfMA0GCSq...",
  DKIMRevokedHost: "",
  DKIMRevokedTextValue: "",
  SafeToRemoveRevokedKeyFromDNS: false,
  DKIMUpdateStatus: "Pending",
  ReturnPathDomain: "pm-bounces.mysite.com",
  ReturnPathDomainVerified: false,
  ReturnPathDomainCNAMEValue: "pm.mtasv.net",
};

const DOMAIN_LIST = {
  TotalCount: 2,
  Domains: [
    { ID: DOMAIN_ID, Name: "mysite.com" },
    { ID: 99, Name: "other.com" },
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

describe("capability gate", () => {
  it("omits `domains` entirely when accountToken is absent", () => {
    const provider = createPostmarkProvider({ serverToken: "pm_server" });
    expect(provider.domains).toBeUndefined();
  });

  it("exposes `domains` when accountToken is configured", () => {
    const provider = createPostmarkProvider({
      serverToken: "pm_server",
      accountToken: "pm_account",
    });
    expect(provider.domains).toBeDefined();
  });
});

const provider = createPostmarkProvider({
  serverToken: "pm_server",
  accountToken: "pm_account",
});
// biome-ignore lint/style/noNonNullAssertion: accountToken is set above
const domains = provider.domains!;

function assertAccountTokenHeader(): void {
  for (const call of fetchMock.mock.calls) {
    const init = call[1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["X-Postmark-Account-Token"]).toBe("pm_account");
  }
}

describe("createPostmarkProvider(...).domains — get", () => {
  it("resolves name → ID via the list, synthesizes DKIM + return-path records", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));

    const status = await domains.get("mysite.com");
    expect(status).not.toBeNull();
    expect(status?.domain).toBe("mysite.com");
    expect(status?.providerId).toBe("postmark");
    expect(status?.raw).toEqual(DOMAIN_DETAIL);

    const [listUrl] = fetchMock.mock.calls[0] as [string];
    expect(listUrl).toContain("https://api.postmarkapp.com/domains?count=");
    const [detailUrl] = fetchMock.mock.calls[1] as [string];
    expect(detailUrl).toBe(`https://api.postmarkapp.com/domains/${DOMAIN_ID}`);
    assertAccountTokenHeader();

    // DKIM record synthesized from the PENDING host/value (rotation pending).
    const dkim = status?.records.find((r) => r.purpose === "dkim");
    expect(dkim).toMatchObject({
      type: "TXT",
      name: "20260609._domainkey.mysite.com",
      value: "k=rsa; p=MIGfMA0GCSq...",
      status: "pending",
    });

    // Return-path CNAME.
    const rp = status?.records.find((r) => r.purpose === "return_path");
    expect(rp).toMatchObject({
      type: "CNAME",
      name: "pm-bounces.mysite.com",
      value: "pm.mtasv.net",
      status: "pending",
    });
  });

  it("uses the active DKIM host/value when no rotation is pending", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(
        jsonResponse({
          ...DOMAIN_DETAIL,
          DKIMVerified: true,
          DKIMHost: "pm._domainkey.mysite.com",
          DKIMTextValue: "k=rsa; p=ACTIVE",
          DKIMPendingHost: "",
          DKIMPendingTextValue: "",
        }),
      );

    const status = await domains.get("mysite.com");
    const dkim = status?.records.find((r) => r.purpose === "dkim");
    expect(dkim).toMatchObject({
      name: "pm._domainkey.mysite.com",
      value: "k=rsa; p=ACTIVE",
      status: "verified",
    });
  });

  it("state is verified ONLY when both DKIM and return-path are verified", async () => {
    for (const [dkimV, rpV, expected] of [
      [true, true, "verified"],
      [true, false, "pending"],
      [false, true, "pending"],
      [false, false, "pending"],
    ] as const) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
        .mockResolvedValueOnce(
          jsonResponse({
            ...DOMAIN_DETAIL,
            DKIMVerified: dkimV,
            ReturnPathDomainVerified: rpV,
          }),
        );
      const status = await domains.get("mysite.com");
      expect(status?.state).toBe(expected);
    }
  });

  it("returns null when the provider doesn't know the domain", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_LIST));
    const status = await domains.get("unknown.com");
    expect(status).toBeNull();
  });
});

describe("createPostmarkProvider(...).domains — create", () => {
  it("POSTs /domains with the account token and normalizes", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_DETAIL));

    const status = await domains.create("mysite.com");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.postmarkapp.com/domains");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ Name: "mysite.com" });
    assertAccountTokenHeader();
    expect(status.domain).toBe("mysite.com");
    expect(status.state).toBe("pending");
  });

  it("falls through to lookup on 422 already-exists (idempotent)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(
          { ErrorCode: 503, Message: "This domain already exists." },
          422,
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
      jsonResponse({ ErrorCode: 10, Message: "Bad account token" }, 401),
    );
    await expect(domains.create("mysite.com")).rejects.toThrow(
      /Bad account token/,
    );
  });
});

describe("createPostmarkProvider(...).domains — verify", () => {
  it("runs verifyDkim + verifyReturnPath, then re-gets", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(DOMAIN_LIST))
      .mockResolvedValueOnce(jsonResponse({ ...DOMAIN_DETAIL }))
      .mockResolvedValueOnce(jsonResponse({ ...DOMAIN_DETAIL }))
      .mockResolvedValueOnce(
        jsonResponse({
          ...DOMAIN_DETAIL,
          DKIMVerified: true,
          ReturnPathDomainVerified: true,
        }),
      );

    // biome-ignore lint/style/noNonNullAssertion: verify is implemented for Postmark
    const status = await domains.verify!("mysite.com");

    const calls = fetchMock.mock.calls.map((c) => [
      (c[1] as RequestInit).method ?? "GET",
      c[0] as string,
    ]);
    expect(calls).toEqual([
      ["GET", expect.stringContaining("/domains?count=")],
      ["PUT", `https://api.postmarkapp.com/domains/${DOMAIN_ID}/verifyDkim`],
      [
        "PUT",
        `https://api.postmarkapp.com/domains/${DOMAIN_ID}/verifyReturnPath`,
      ],
      ["GET", `https://api.postmarkapp.com/domains/${DOMAIN_ID}`],
    ]);
    expect(status.state).toBe("verified");
  });
});

describe("createPostmarkProvider(...).domains — records", () => {
  it("returns [] for an unknown domain", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(DOMAIN_LIST));
    const records = await domains.records("unknown.com");
    expect(records).toEqual([]);
  });
});
