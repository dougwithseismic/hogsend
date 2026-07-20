import type {
  DomainStatus,
  EmailProvider,
  SendEmailOptions,
} from "@hogsend/core";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// Route-level config for this file's container: env-flag-forced test mode.
// (Service/mailer-level cases below inject their own fake env / fake
// DomainStatusService, so they are independent of these two lines.)
process.env.EMAIL_DOMAIN = "mysite.com";
process.env.HOGSEND_TEST_MODE = "true";
process.env.HOGSEND_TEST_EMAIL = "safe@x.dev";

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

const {
  createApp,
  createDomainStatusService,
  createHogsendClient,
  createTrackedMailer,
} = await import("@hogsend/engine");
type Engine = typeof import("@hogsend/engine");
type DomainStatusService = Engine["createDomainStatusService"] extends (
  ...args: never[]
) => infer R
  ? R
  : never;
type TestModeState = ReturnType<DomainStatusService["testModeCached"]>;
type EngineEnv = Parameters<typeof createDomainStatusService>[0]["env"];
type EngineLogger = Parameters<typeof createDomainStatusService>[0]["logger"];

const { templates } = await import("../emails/index.js");

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// Compile a captured drizzle WHERE to its bound params (mirrors mailer.test.ts)
// so the suppression SELECT can be asserted to key on the ORIGINAL recipient.
const whereParams = (cond: unknown): unknown[] =>
  new PgDialect().sqlToQuery(cond as SQL).params;

// --- Fixtures ---------------------------------------------------------------

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
  return { logger, calls };
}

function makeDomainStatus(over: Partial<TestModeState> = {}) {
  const state: TestModeState = {
    active: false,
    reason: null,
    redirectTo: null,
    fromOverride: null,
    ...over,
  };
  const refreshIfStale = vi.fn();
  const service = {
    getStatus: vi.fn(async () => {
      throw new Error("unused");
    }),
    isVerifiedCached: () => !state.active,
    testModeCached: () => ({ ...state }),
    refreshIfStale,
  } as unknown as DomainStatusService;
  return { service, refreshIfStale };
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

function makeProvider(
  opts: { id?: string; state?: DomainStatus["state"] } = {},
) {
  const send = vi.fn(async (_o: SendEmailOptions) => ({ id: "msg_1" }));
  const sendBatch = vi.fn(async (emails: SendEmailOptions[]) => ({
    results: emails.map((_, i) => ({ id: `msg_${i}` })),
  }));
  const domainsGet = vi.fn(async () =>
    makeStatus({ state: opts.state ?? "pending" }),
  );
  const provider: EmailProvider = {
    meta: { id: opts.id ?? "resend", name: "Fake" },
    send,
    sendBatch,
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
  return { provider, send, sendBatch, domainsGet };
}

/** Minimal env slice the domain-status service reads. */
function makeEnv(over: Record<string, string | undefined> = {}): EngineEnv {
  return {
    EMAIL_DOMAIN: "mysite.com",
    EMAIL_FROM: undefined,
    RESEND_FROM_EMAIL: "noreply@hogsend.com",
    HOGSEND_TEST_MODE: "auto",
    HOGSEND_TEST_EMAIL: undefined,
    STUDIO_ADMIN_EMAIL: undefined,
    ...over,
  } as unknown as EngineEnv;
}

/**
 * Chainable fake db capturing the email_sends INSERT values + the suppression
 * SELECT's WHERE (extends mailer.test.ts's makeFakeDb with an insert chain).
 */
function makeFakeDb(opts: { prefsRows?: unknown[] } = {}) {
  const inserts: Array<Record<string, unknown>> = [];
  const sets: Array<Record<string, unknown>> = [];
  const selectWheres: unknown[] = [];
  const selectChain = {
    from: () => selectChain,
    leftJoin: () => selectChain,
    where: (cond: unknown) => {
      selectWheres.push(cond);
      return selectChain;
    },
    limit: () => Promise.resolve(opts.prefsRows ?? []),
    // `checkSuppression` awaits the WHERE directly (it aggregates ALL rows for
    // the address, no .limit) — a thenable chain lets both `await chain` and
    // `await chain.limit()` resolve the rows.
    // biome-ignore lint/suspicious/noThenProperty: intentionally thenable, mirroring drizzle's awaitable query builder
    then: (resolve: (rows: unknown[]) => unknown) =>
      resolve(opts.prefsRows ?? []),
  };
  const db = {
    select() {
      return selectChain;
    },
    insert() {
      return {
        values(v: Record<string, unknown>) {
          inserts.push(v);
          const chain = {
            onConflictDoNothing: () => chain,
            returning: () =>
              Promise.resolve([{ id: "send_1", status: "queued" }]),
          };
          return chain;
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          sets.push(values);
          return { where: () => Promise.resolve() };
        },
      };
    },
  };
  return { db: db as never, inserts, sets, selectWheres };
}

const baseConfig = {
  defaultFrom: "Hogsend <noreply@hogsend.com>",
  templates,
};

const ACTIVE: Partial<TestModeState> = {
  active: true,
  reason: "domain_unverified",
  redirectTo: "safe@x.dev",
};

// --- Mailer-level: redirect on the wire (fake DomainStatusService) ----------

describe("createTrackedMailer test mode (no-db send)", () => {
  it("redirects to/subject and fires the structured WARN", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus(ACTIVE);
    const { logger, calls } = makeLogger();
    const mailer = createTrackedMailer(
      { ...baseConfig, logger },
      { provider, domainStatus: service },
    );

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(result.status).toBe("sent");
    expect(send).toHaveBeenCalledTimes(1);
    const wire = send.mock.calls[0]?.[0];
    expect(wire?.to).toEqual(["safe@x.dev"]);
    expect(wire?.subject).toBe("[TEST → orig@y.com] Welcome to Hogsend");
    // No fromOverride scripted → original from kept.
    expect(wire?.from).toBe(baseConfig.defaultFrom);
    const warn = calls.find(
      (c) => c.level === "warn" && c.message === "email.test_mode_redirect",
    );
    expect(warn).toBeDefined();
    expect(warn?.meta).toMatchObject({
      event: "email.test_mode_redirect",
      redirectTo: "safe@x.dev",
      reason: "domain_unverified",
    });
  });

  it("applies fromOverride when set (Resend unverified)", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus({
      ...ACTIVE,
      fromOverride: "onboarding@resend.dev",
    });
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(send.mock.calls[0]?.[0]?.from).toBe("onboarding@resend.dev");
  });

  it("leaves the wire untouched when test mode is inactive", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus(); // inactive
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    const wire = send.mock.calls[0]?.[0];
    expect(wire?.to).toBe("orig@y.com");
    expect(wire?.subject).toBe("Welcome to Hogsend");
    expect(wire?.from).toBe(baseConfig.defaultFrom);
  });

  it("works without a domainStatus dep (today's behavior preserved)", async () => {
    const { provider, send } = makeProvider();
    const mailer = createTrackedMailer(baseConfig, { provider });

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(result.status).toBe("sent");
    expect(send.mock.calls[0]?.[0]?.to).toBe("orig@y.com");
  });

  it("hard-fails (no provider call, skipped result) when active without a redirect address", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus({ ...ACTIVE, redirectTo: null });
    const { logger, calls } = makeLogger();
    const mailer = createTrackedMailer(
      { ...baseConfig, logger },
      { provider, domainStatus: service },
    );

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("test_mode_blocked");
    expect(
      calls.some(
        (c) => c.level === "error" && /HOGSEND_TEST_EMAIL/.test(c.message),
      ),
    ).toBe(true);
  });

  it("calls refreshIfStale exactly once per send (fire-and-forget)", async () => {
    const { provider } = makeProvider();
    const { service, refreshIfStale } = makeDomainStatus();
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });
    expect(refreshIfStale).toHaveBeenCalledTimes(1);

    await mailer.sendRaw({ to: "a@y.com", subject: "s", html: "<p>x</p>" });
    expect(refreshIfStale).toHaveBeenCalledTimes(2);
  });
});

describe("createTrackedMailer test mode (sendRaw / sendBatch)", () => {
  it("sendRaw redirects, drops cc/bcc, and prefixes the subject with ALL original recipients", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus(ACTIVE);
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    await mailer.sendRaw({
      to: "orig@y.com",
      cc: "c@y.com",
      bcc: ["b@y.com"],
      subject: "Hello",
      html: "<p>hi</p>",
    });

    const wire = send.mock.calls[0]?.[0];
    expect(wire?.to).toEqual(["safe@x.dev"]);
    expect(wire?.cc).toBeUndefined();
    expect(wire?.bcc).toBeUndefined();
    expect(wire?.subject).toBe("[TEST → orig@y.com,c@y.com,b@y.com] Hello");
  });

  it("sendBatch redirects every item with its OWN prefix and logs ONE warn for the batch", async () => {
    const { provider, sendBatch } = makeProvider();
    const { service } = makeDomainStatus(ACTIVE);
    const { logger, calls } = makeLogger();
    const mailer = createTrackedMailer(
      { ...baseConfig, logger },
      { provider, domainStatus: service },
    );

    await mailer.sendBatch({
      emails: [
        {
          from: "a@hogsend.com",
          to: "one@y.com",
          subject: "S1",
          html: "<p>1</p>",
        },
        {
          from: "a@hogsend.com",
          to: ["two@y.com"],
          subject: "S2",
          html: "<p>2</p>",
        },
      ],
    });

    const items = sendBatch.mock.calls[0]?.[0];
    expect(items?.[0]?.to).toEqual(["safe@x.dev"]);
    expect(items?.[0]?.subject).toBe("[TEST → one@y.com] S1");
    expect(items?.[1]?.subject).toBe("[TEST → two@y.com] S2");

    const warns = calls.filter(
      (c) => c.level === "warn" && c.message === "email.test_mode_redirect",
    );
    expect(warns).toHaveLength(1);
    expect(warns[0]?.meta).toMatchObject({
      count: 2,
      redirectTo: "safe@x.dev",
      originalTo: ["one@y.com", "two@y.com"],
    });
  });

  it("sendRaw / sendBatch throw loudly when active without a redirect address", async () => {
    const { provider, send, sendBatch } = makeProvider();
    const { service } = makeDomainStatus({ ...ACTIVE, redirectTo: null });
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    await expect(
      mailer.sendRaw({ to: "x@y.com", subject: "s", html: "<p>x</p>" }),
    ).rejects.toThrow(/HOGSEND_TEST_EMAIL/);
    await expect(
      mailer.sendBatch({
        emails: [{ from: "a@b.com", to: "x@y.com", subject: "s", html: "h" }],
      }),
    ).rejects.toThrow(/HOGSEND_TEST_EMAIL/);
    expect(send).not.toHaveBeenCalled();
    expect(sendBatch).not.toHaveBeenCalled();
  });
});

// --- DB path: row shape + original-recipient preference keying --------------

describe("test mode on the tracked (DB) path", () => {
  it("writes the email_sends row with toEmail=redirect, prefixed subject, and metadata.originalTo", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus({
      ...ACTIVE,
      fromOverride: "onboarding@resend.dev",
    });
    const { db, inserts } = makeFakeDb();
    const mailer = createTrackedMailer(
      { ...baseConfig, db, baseUrl: "http://localhost:3002" },
      { provider, domainStatus: service },
    );

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(result.status).toBe("sent");
    const row = inserts[0];
    expect(row?.toEmail).toBe("safe@x.dev");
    expect(row?.fromEmail).toBe("onboarding@resend.dev");
    expect(row?.subject).toBe("[TEST → orig@y.com] Welcome to Hogsend");
    expect(row?.metadata).toEqual({ testMode: true, originalTo: "orig@y.com" });
    // The recipient's logical identity stays the ORIGINAL address.
    expect(row?.userEmail).toBe("orig@y.com");
    // The wire matches the row.
    const wire = send.mock.calls[0]?.[0];
    expect(wire?.to).toEqual(["safe@x.dev"]);
    expect(wire?.from).toBe("onboarding@resend.dev");
    expect(wire?.subject).toBe("[TEST → orig@y.com] Welcome to Hogsend");
  });

  it("keys suppression to the ORIGINAL recipient (suppressed user blocked even in test mode)", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus(ACTIVE);
    const { db, inserts, selectWheres } = makeFakeDb({
      prefsRows: [{ suppressed: true }],
    });
    const mailer = createTrackedMailer(
      { ...baseConfig, db },
      { provider, domainStatus: service },
    );

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(result.status).toBe("suppressed");
    expect(send).not.toHaveBeenCalled();
    // The preference SELECT was keyed on the original recipient, not the inbox.
    expect(whereParams(selectWheres[0])).toContain("orig@y.com");
    expect(whereParams(selectWheres[0])).not.toContain("safe@x.dev");
    // The suppression record keeps the original recipient too.
    expect(inserts[0]?.toEmail).toBe("orig@y.com");
  });

  it("hard-fails on the DB path: failed row + metadata, provider never called", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus({ ...ACTIVE, redirectTo: null });
    const { db, inserts } = makeFakeDb();
    const { logger, calls } = makeLogger();
    const mailer = createTrackedMailer(
      { ...baseConfig, db, logger },
      { provider, domainStatus: service },
    );

    const result = await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(send).not.toHaveBeenCalled();
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("test_mode_blocked");
    const row = inserts[0];
    expect(row?.status).toBe("suppressed");
    expect(row?.metadata).toEqual({ testMode: true, originalTo: "orig@y.com" });
    expect(calls.some((c) => c.level === "error")).toBe(true);
  });

  it("does NOT touch the row or wire when inactive", async () => {
    const { provider, send } = makeProvider();
    const { service } = makeDomainStatus();
    const { db, inserts } = makeFakeDb();
    const mailer = createTrackedMailer(
      { ...baseConfig, db },
      { provider, domainStatus: service },
    );

    await mailer.send({
      template: "welcome",
      props: { name: "Doug" },
      to: "orig@y.com",
    });

    expect(inserts[0]?.toEmail).toBe("orig@y.com");
    expect(inserts[0]?.metadata).toBeUndefined();
    expect(send.mock.calls[0]?.[0]?.to).toBe("orig@y.com");
  });
});

// --- Service-level: resolveTestMode semantics (real service, fake env) ------

describe("createDomainStatusService test-mode resolution", () => {
  it("HOGSEND_TEST_MODE=true forces test mode even when the domain is verified", async () => {
    const { provider } = makeProvider({ state: "verified" });
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({
        HOGSEND_TEST_MODE: "true",
        HOGSEND_TEST_EMAIL: "safe@x.dev",
      }),
      logger,
    });

    const status = await service.getStatus({ refresh: true });
    expect(status.testMode).toEqual({
      active: true,
      reason: "env_flag",
      redirectTo: "safe@x.dev",
      fromOverride: "onboarding@resend.dev",
    });
    expect(service.testModeCached().active).toBe(true);
  });

  it("HOGSEND_TEST_MODE=false never activates, even when unverified", async () => {
    const { provider } = makeProvider({ state: "pending" });
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ HOGSEND_TEST_MODE: "false" }),
      logger,
    });

    const status = await service.getStatus({ refresh: true });
    expect(status.testMode.active).toBe(false);
    expect(status.testMode.reason).toBeNull();
  });

  it("auto + unverified domain ⇒ active; auto + verified ⇒ auto-exit; one transition log per flip", async () => {
    const { provider, domainsGet } = makeProvider({ state: "pending" });
    const { logger, calls } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ HOGSEND_TEST_EMAIL: "safe@x.dev" }),
      logger,
    });

    let status = await service.getStatus({ refresh: true });
    expect(status.testMode).toMatchObject({
      active: true,
      reason: "domain_unverified",
      redirectTo: "safe@x.dev",
      fromOverride: "onboarding@resend.dev",
    });
    // Entering banner logged ONCE.
    const enterWarns = () =>
      calls.filter(
        (c) => c.level === "warn" && /test mode ACTIVE/i.test(c.message),
      );
    expect(enterWarns()).toHaveLength(1);

    // Still unverified: a second refresh does NOT re-log.
    await service.getStatus({ refresh: true });
    expect(enterWarns()).toHaveLength(1);

    // DNS verifies → auto-exit + exit transition logged once.
    domainsGet.mockResolvedValue(makeStatus({ state: "verified" }));
    status = await service.getStatus({ refresh: true });
    expect(status.testMode.active).toBe(false);
    expect(status.testMode.fromOverride).toBeNull();
    const exitInfos = calls.filter(
      (c) => c.level === "info" && /sends are LIVE/i.test(c.message),
    );
    expect(exitInfos).toHaveLength(1);
  });

  it("fails OPEN: provider outage / cold cache ⇒ auto resolves inactive", async () => {
    const { provider, domainsGet } = makeProvider();
    domainsGet.mockRejectedValue(new Error("resend is down"));
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ HOGSEND_TEST_EMAIL: "safe@x.dev" }),
      logger,
    });

    // Cold cache, refresh in flight + failing — sends must stay live.
    expect(service.testModeCached().active).toBe(false);
    service.refreshIfStale();
    await new Promise((r) => setTimeout(r, 0));
    expect(service.testModeCached().active).toBe(false);
  });

  it("auto WITHOUT an explicit EMAIL_DOMAIN stays live (existing deploys unaffected)", async () => {
    // Domain derives from RESEND_FROM_EMAIL, the provider reports it unverified —
    // but auto only arms when EMAIL_DOMAIN is explicitly configured.
    const { provider } = makeProvider({ state: "pending" });
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ EMAIL_DOMAIN: undefined }),
      logger,
    });

    const status = await service.getStatus({ refresh: true });
    expect(status.domain).toBe("hogsend.com"); // still derived + reported
    expect(status.status?.state).toBe("pending");
    expect(status.testMode.active).toBe(false);
  });

  it("redirectTo precedence: HOGSEND_TEST_EMAIL > STUDIO_ADMIN_EMAIL > null", async () => {
    const { provider } = makeProvider();
    const { logger } = makeLogger();
    // Force test mode active (env_flag) so redirectTo is populated regardless of
    // the cold cache; the precedence rule is what's under test here.
    const forced = { HOGSEND_TEST_MODE: "true" as const };

    const both = createDomainStatusService({
      provider,
      env: makeEnv({
        ...forced,
        HOGSEND_TEST_EMAIL: "test@x.dev",
        STUDIO_ADMIN_EMAIL: "admin@x.dev",
      }),
      logger,
    });
    expect(both.testModeCached().redirectTo).toBe("test@x.dev");

    const adminOnly = createDomainStatusService({
      provider,
      env: makeEnv({ ...forced, STUDIO_ADMIN_EMAIL: "admin@x.dev" }),
      logger,
    });
    expect(adminOnly.testModeCached().redirectTo).toBe("admin@x.dev");

    const neither = createDomainStatusService({
      provider,
      env: makeEnv({ ...forced }),
      logger,
    });
    expect(neither.testModeCached().redirectTo).toBeNull();
  });

  it("fromOverride is Resend-only (Postmark keeps the original from)", async () => {
    const { provider } = makeProvider({ id: "postmark", state: "pending" });
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ HOGSEND_TEST_EMAIL: "safe@x.dev" }),
      logger,
    });

    const status = await service.getStatus({ refresh: true });
    expect(status.testMode.active).toBe(true);
    expect(status.testMode.fromOverride).toBeNull();
  });
});

// --- Zero per-send latency (Level-2 exit criterion) --------------------------

describe("zero per-send provider latency", () => {
  it("N sends within TTL add ZERO domains.get calls (real service over the mailer)", async () => {
    const { provider, domainsGet } = makeProvider({ state: "pending" });
    const { logger } = makeLogger();
    const service = createDomainStatusService({
      provider,
      env: makeEnv({ HOGSEND_TEST_EMAIL: "safe@x.dev" }),
      logger,
    });
    const mailer = createTrackedMailer(baseConfig, {
      provider,
      domainStatus: service,
    });

    // Prime the cache once (the boot warm-up role).
    await service.getStatus({ refresh: true });
    const baseline = domainsGet.mock.calls.length;

    for (let i = 0; i < 10; i++) {
      await mailer.send({
        template: "welcome",
        props: { name: "Doug" },
        to: `user${i}@y.com`,
      });
    }
    expect(domainsGet.mock.calls.length).toBe(baseline);
  });
});

// --- Route-level: GET /v1/admin/domain reports the live block ---------------

describe("GET /v1/admin/domain (env-flag-forced test mode)", () => {
  it("reports the live testMode block", async () => {
    const { provider } = makeProvider({ state: "verified" });
    const container = createHogsendClient({ email: { provider } });
    const app = createApp(container);

    const res = await app.request("/v1/admin/domain?refresh=true", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.testMode).toEqual({
      active: true,
      reason: "env_flag",
      redirectTo: "safe@x.dev",
      fromOverride: "onboarding@resend.dev",
    });
  });
});
