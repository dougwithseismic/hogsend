import type { DomainStatus, EmailProvider } from "@hogsend/core";
import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createDomainStatusService } = await import("@hogsend/engine");

type EngineEnv = Parameters<typeof createDomainStatusService>[0]["env"];
type EngineLogger = Parameters<typeof createDomainStatusService>[0]["logger"];

// --- Fixtures (mirrors test-mode-sends.test.ts) ------------------------------

function makeLogger() {
  const calls: Array<{ level: string; message: string; meta?: unknown }> = [];
  const record =
    (level: string) =>
    (message: string, meta?: unknown): void => {
      calls.push({ level, message, meta });
    };
  const logger = {
    error: record("error"),
    warn: record("warn"),
    info: record("info"),
    http: record("http"),
    debug: record("debug"),
  } as unknown as EngineLogger;
  const warns = () => calls.filter((c) => c.level === "warn");
  return { logger, calls, warns };
}

function makeEnv(over: Record<string, string | undefined> = {}): EngineEnv {
  return {
    EMAIL_DOMAIN: "mysite.com",
    EMAIL_FROM: undefined,
    RESEND_FROM_EMAIL: "noreply@mysite.com",
    HOGSEND_TEST_MODE: "auto",
    HOGSEND_TEST_EMAIL: "safe@x.dev",
    STUDIO_ADMIN_EMAIL: undefined,
    ...over,
  } as unknown as EngineEnv;
}

function makeStatus(over: Partial<DomainStatus> = {}): DomainStatus {
  return {
    domain: "mysite.com",
    state: "pending",
    records: [],
    providerId: "resend",
    checkedAt: new Date().toISOString(),
    ...over,
  };
}

function makeProvider() {
  const domainsGet = vi.fn(
    async (): Promise<DomainStatus | null> => makeStatus(),
  );
  const provider: EmailProvider = {
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
      create: vi.fn(async (domain: string) => makeStatus({ domain })),
      get: domainsGet,
      records: async () => [],
    },
  };
  return { provider, domainsGet };
}

/** Flush the fire-and-forget refreshIfStale promise chain. */
const flush = () => new Promise((r) => setTimeout(r, 0));

const RESTRICTED_401 = new Error(
  "Resend domains API 401: This API key is restricted to only send emails",
);

// --- Permission-denied (401/403): warn once + back off -----------------------

describe("restricted (send-only) key: 401 from the domains API", () => {
  it("warns ONCE, assumes verified (fail-open), and stops re-probing", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(RESTRICTED_401);
    const { logger, warns } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv(),
      logger,
    });

    service.refreshIfStale();
    await flush();
    expect(domainsGet).toHaveBeenCalledTimes(1);

    // ONE clear warn explaining the degradation — not the generic
    // "domain-status refresh failed" line.
    expect(warns()).toHaveLength(1);
    const warn = warns()[0];
    expect(warn?.message).toMatch(/cannot read domains/i);
    expect(warn?.message).toMatch(/assumed-verified/i);
    expect(warn?.message).toMatch(/HOGSEND_TEST_MODE=auto/);
    expect(warn?.message).toMatch(/HOGSEND_TEST_MODE=true/);
    expect(warn?.meta).toMatchObject({
      domain: "mysite.com",
      providerId: "resend",
      error: RESTRICTED_401.message,
    });

    // Fail-open contract: assumed verified, auto test mode stays inert —
    // production mail is never redirected by a restricted key.
    expect(service.isVerifiedCached()).toBe(true);
    expect(service.testModeCached()).toEqual({
      active: false,
      reason: null,
      redirectTo: null,
      fromOverride: null,
    });

    // Back-off: repeated stale checks within the window do NOT re-probe the
    // provider and do NOT warn again.
    service.refreshIfStale();
    service.refreshIfStale();
    await flush();
    expect(domainsGet).toHaveBeenCalledTimes(1);
    expect(warns()).toHaveLength(1);
  });

  it("treats a 403 the same as a 401", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(
      new Error("Postmark domains API request failed with status 403"),
    );
    const { logger, warns } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv(),
      logger,
    });

    service.refreshIfStale();
    await flush();
    service.refreshIfStale();
    await flush();

    expect(domainsGet).toHaveBeenCalledTimes(1);
    expect(warns()).toHaveLength(1);
    expect(warns()[0]?.message).toMatch(/cannot read domains/i);
    expect(service.isVerifiedCached()).toBe(true);
  });

  it("explicit getStatus({ refresh: true }) still probes and recovers from the block", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(RESTRICTED_401);
    const { logger, warns } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv(),
      logger,
    });

    service.refreshIfStale();
    await flush();
    expect(domainsGet).toHaveBeenCalledTimes(1);

    // The key gets swapped for a full-access one: an explicit refresh (admin
    // route / CLI `domain check`) bypasses the back-off and succeeds.
    domainsGet.mockResolvedValue(makeStatus({ state: "verified" }));
    const status = await service.getStatus({ refresh: true });
    expect(domainsGet).toHaveBeenCalledTimes(2);
    expect(status.status?.state).toBe("verified");
    expect(service.isVerifiedCached()).toBe(true);

    // The block + once-only warn gate were reset by the successful probe: a
    // NEW restriction episode warns once again.
    domainsGet.mockRejectedValue(RESTRICTED_401);
    await service.getStatus({ refresh: true }).catch(() => {});
    service.refreshIfStale();
    await flush();
    expect(
      warns().filter((w) => /cannot read domains/i.test(w.message)),
    ).toHaveLength(2);
  });
});

// --- Transient failures (network, 5xx): unchanged behavior -------------------

describe("transient failures keep today's behavior", () => {
  it("a 500 warns the generic line every stale refresh and keeps re-probing", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(
      new Error("Resend domains API request failed with status 500"),
    );
    const { logger, warns } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv(),
      logger,
    });

    service.refreshIfStale();
    await flush();
    service.refreshIfStale();
    await flush();

    // No permission back-off: every stale refresh probes + warns generically.
    expect(domainsGet).toHaveBeenCalledTimes(2);
    expect(warns()).toHaveLength(2);
    for (const w of warns()) {
      expect(w.message).toBe("domain-status refresh failed");
    }

    // Fail-open holds for transient failures exactly as before.
    expect(service.isVerifiedCached()).toBe(true);
    expect(service.testModeCached().active).toBe(false);
  });

  it("a network error (no status code) also keeps the generic path", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(new Error("fetch failed: ECONNREFUSED"));
    const { logger, warns } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv(),
      logger,
    });

    service.refreshIfStale();
    await flush();
    service.refreshIfStale();
    await flush();

    expect(domainsGet).toHaveBeenCalledTimes(2);
    expect(warns()).toHaveLength(2);
    expect(warns()[0]?.message).toBe("domain-status refresh failed");
    expect(service.isVerifiedCached()).toBe(true);
  });
});
