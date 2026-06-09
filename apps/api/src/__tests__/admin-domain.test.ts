import type { DomainStatus, EmailProvider } from "@hogsend/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// Deterministic domain derivation for every assertion below.
process.env.EMAIL_DOMAIN = "mysite.com";

vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

vi.mock("../workflows/send-email.js", () => ({
  sendEmailTask: { run: vi.fn(), runNoWait: vi.fn() },
}));

const { createApp, createHogsendClient } = await import("@hogsend/engine");

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// --- Fake provider with a scripted domains capability ----------------------

function makeStatus(overrides: Partial<DomainStatus> = {}): DomainStatus {
  return {
    domain: "mysite.com",
    state: "pending",
    records: [
      {
        type: "TXT",
        name: "resend._domainkey",
        value: "p=FAKE",
        purpose: "dkim",
        status: "pending",
      },
    ],
    providerId: "resend",
    checkedAt: new Date().toISOString(),
    ...overrides,
  };
}

const domainsGet = vi.fn(async () => makeStatus());
const domainsCreate = vi.fn(async (domain: string) =>
  makeStatus({ domain, state: "pending" }),
);
const domainsVerify = vi.fn(async () => makeStatus({ state: "verified" }));

const fakeProvider: EmailProvider = {
  meta: { id: "resend", name: "Fake Resend" },
  send: async () => ({ id: "fake-send" }),
  sendBatch: async () => ({ results: [] }),
  verifyWebhook: () => {
    throw new Error("unused");
  },
  parseWebhook: () => {
    throw new Error("unused");
  },
  domains: {
    create: domainsCreate,
    get: domainsGet,
    records: async () => [],
    verify: domainsVerify,
  },
};

const fakeUnsupported: EmailProvider = {
  meta: { id: "no-domains", name: "No Domains" },
  send: async () => ({ id: "fake-send" }),
  sendBatch: async () => ({ results: [] }),
  verifyWebhook: () => {
    throw new Error("unused");
  },
  parseWebhook: () => {
    throw new Error("unused");
  },
};

const container = createHogsendClient({ email: { provider: fakeProvider } });
const app = createApp(container);

const unsupportedContainer = createHogsendClient({
  email: { provider: fakeUnsupported, defaultProvider: "no-domains" },
});
const unsupportedApp = createApp(unsupportedContainer);

beforeEach(() => {
  domainsGet.mockClear();
  domainsCreate.mockClear();
  domainsVerify.mockClear();
});

const STUBBED_TEST_MODE = {
  active: false,
  reason: null,
  redirectTo: null,
  fromOverride: null,
};

describe("GET /v1/admin/domain", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/domain");
    expect(res.status).toBe(401);
  });

  it("returns the EngineDomainStatus with the stubbed inactive testMode", async () => {
    const res = await app.request("/v1/admin/domain?refresh=true", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.domain).toBe("mysite.com");
    expect(body.providerId).toBe("resend");
    expect(body.supported).toBe(true);
    expect(body.status.state).toBe("pending");
    expect(body.status.records).toHaveLength(1);
    expect(body.status.records[0]).toMatchObject({
      type: "TXT",
      purpose: "dkim",
      status: "pending",
    });
    // F1 ships the FULL testMode shape, stubbed inactive (F3 lights it up).
    expect(body.testMode).toEqual(STUBBED_TEST_MODE);
  });

  it("serves repeat un-refreshed GETs from the cache (one provider call)", async () => {
    // Prime deterministically (busts whatever earlier tests left behind).
    await app.request("/v1/admin/domain?refresh=true", {
      headers: AUTH_HEADER,
    });
    expect(domainsGet).toHaveBeenCalledTimes(1);

    // Two un-refreshed GETs within TTL → ZERO further provider calls.
    await app.request("/v1/admin/domain", { headers: AUTH_HEADER });
    await app.request("/v1/admin/domain", { headers: AUTH_HEADER });
    expect(domainsGet).toHaveBeenCalledTimes(1);
  });

  it("?refresh=true bypasses the cache (exactly one extra provider call)", async () => {
    await app.request("/v1/admin/domain", { headers: AUTH_HEADER });
    const baseline = domainsGet.mock.calls.length;

    const res = await app.request("/v1/admin/domain?refresh=true", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(domainsGet.mock.calls.length).toBe(baseline + 1);
  });
});

describe("POST /v1/admin/domain", () => {
  it("creates the domain at the provider and busts the cache", async () => {
    const res = await app.request("/v1/admin/domain", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "mysite.com" }),
    });
    expect(res.status).toBe(200);

    expect(domainsCreate).toHaveBeenCalledTimes(1);
    expect(domainsCreate).toHaveBeenCalledWith("mysite.com");
    // Cache bust: the response was rebuilt from a fresh provider get.
    expect(domainsGet).toHaveBeenCalledTimes(1);

    const body = await res.json();
    expect(body.supported).toBe(true);
    expect(body.status.state).toBe("pending");
    expect(body.testMode).toEqual(STUBBED_TEST_MODE);
  });

  it("rejects an invalid domain with 400", async () => {
    const res = await app.request("/v1/admin/domain", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "not a domain" }),
    });
    expect(res.status).toBe(400);
    expect(domainsCreate).not.toHaveBeenCalled();
  });
});

describe("POST /v1/admin/domain/verify", () => {
  it("runs the provider verification pass on the resolved domain", async () => {
    const res = await app.request("/v1/admin/domain/verify", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    expect(domainsVerify).toHaveBeenCalledTimes(1);
    expect(domainsVerify).toHaveBeenCalledWith("mysite.com");
  });
});

describe("provider WITHOUT the domains capability", () => {
  it("GET reports supported:false with a null status (no provider call)", async () => {
    const res = await unsupportedApp.request("/v1/admin/domain", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.providerId).toBe("no-domains");
    expect(body.supported).toBe(false);
    expect(body.status).toBeNull();
    expect(body.testMode).toEqual(STUBBED_TEST_MODE);
  });

  it("POST / returns 501 provider_unsupported", async () => {
    const res = await unsupportedApp.request("/v1/admin/domain", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ domain: "mysite.com" }),
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "provider_unsupported" });
  });

  it("POST /verify returns 501 provider_unsupported", async () => {
    const res = await unsupportedApp.request("/v1/admin/domain/verify", {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(501);
    expect(await res.json()).toEqual({ error: "provider_unsupported" });
  });
});

describe("per-send safety contract (sync, cache-only)", () => {
  it("isVerifiedCached/testModeCached never await; N getStatus within TTL → one call", async () => {
    await container.domainStatus.getStatus({ refresh: true });
    const baseline = domainsGet.mock.calls.length;

    for (let i = 0; i < 5; i++) {
      await container.domainStatus.getStatus();
    }
    expect(domainsGet.mock.calls.length).toBe(baseline);

    // Sync + cache-only — plain (non-Promise) returns.
    const verified = container.domainStatus.isVerifiedCached();
    expect(typeof verified).toBe("boolean");
    expect(verified).toBe(false); // cached state is "pending"

    const testMode = container.domainStatus.testModeCached();
    expect(testMode).toEqual(STUBBED_TEST_MODE);
    expect(domainsGet.mock.calls.length).toBe(baseline);
  });

  it("fails OPEN when nothing is cached (unsupported provider)", () => {
    expect(unsupportedContainer.domainStatus.isVerifiedCached()).toBe(true);
  });
});

describe("OpenAPI registration", () => {
  it("exposes the domain routes in /openapi.json", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = await res.json();
    const paths = Object.keys(doc.paths ?? {});
    expect(
      paths.some((p) => p === "/v1/admin/domain" || p === "/v1/admin/domain/"),
    ).toBe(true);
    expect(paths).toContain("/v1/admin/domain/verify");
  });
});
