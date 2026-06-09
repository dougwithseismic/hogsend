import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet is module-mocked so building a container never dials a live engine.
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

const {
  createApp,
  createHogsendClient,
  logSetupTokenOnFirstBoot,
  resetSetupToken,
  resolveSetupToken,
  timingSafeEqualStr,
} = await import("@hogsend/engine");

type Container = ReturnType<typeof createHogsendClient>;

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as Container["hatchet"];

/**
 * A minimal `db` stub whose ONLY job is to make the sign-up middleware's
 * `existing.length` deterministic regardless of the shared TimescaleDB's state.
 * `select(...).from(...).limit(...)` resolves to the configured user-count rows.
 */
function fakeDb(userRows: Array<{ id: string }>): Container["db"] {
  const chain = {
    from: () => chain,
    limit: () => Promise.resolve(userRows),
  };
  return {
    select: () => chain,
  } as unknown as Container["db"];
}

/**
 * A stub better-auth whose `handler` returns 200 — so we can assert the GATE
 * forwarded the request (the token check passed) without exercising better-auth's
 * full sign-up. The security control under test is the engine gate, not
 * better-auth internals (those are covered by the live-DB suite).
 */
function passthroughAuth(): Container["auth"] {
  return {
    handler: vi.fn(async () => new Response("ok", { status: 200 })),
  } as unknown as Container["auth"];
}

function appWith(opts: { userRows: Array<{ id: string }>; envToken?: string }) {
  // Resolve the env token off the validated engine env, then override it for the
  // scenario so we don't have to re-import the frozen env module.
  const container = createHogsendClient({
    overrides: {
      hatchet: mockHatchet,
      db: fakeDb(opts.userRows),
      auth: passthroughAuth(),
    },
  });
  // The gate reads `container.env.STUDIO_SETUP_TOKEN`; override on the resolved
  // container so each scenario controls the env vs auto-generated branch.
  (container.env as { STUDIO_SETUP_TOKEN?: string }).STUDIO_SETUP_TOKEN =
    opts.envToken;
  const app = createApp(container);
  return { app, container };
}

function signUpReq(token?: string, opts: { ip?: string } = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { "x-hogsend-setup-token": token } : {}),
      ...(opts.ip ? { "x-forwarded-for": opts.ip } : {}),
    },
    body: JSON.stringify({
      email: "first-admin@setup-token-test.example",
      password: "supersecret123",
      name: "First Admin",
    }),
  };
}

beforeEach(() => {
  resetSetupToken();
});

afterEach(() => {
  resetSetupToken();
  vi.restoreAllMocks();
});

// --- Unit: constant-time compare ---

describe("timingSafeEqualStr", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStr("abc123", "abc123")).toBe(true);
  });

  it("returns false for different same-length strings", () => {
    expect(timingSafeEqualStr("abc123", "abc124")).toBe(false);
  });

  it("returns false for different-length strings without throwing", () => {
    expect(timingSafeEqualStr("short", "a-much-longer-token")).toBe(false);
    expect(timingSafeEqualStr("a-much-longer-token", "short")).toBe(false);
  });

  it("returns false when either side is empty", () => {
    expect(timingSafeEqualStr("", "abc")).toBe(false);
    expect(timingSafeEqualStr("abc", "")).toBe(false);
    expect(timingSafeEqualStr("", "")).toBe(false);
  });
});

// --- Unit: resolveSetupToken precedence ---

describe("resolveSetupToken", () => {
  it("returns the env token verbatim when set", () => {
    expect(resolveSetupToken("operator-token")).toBe("operator-token");
  });

  it("auto-generates a stable token when env is unset", () => {
    const first = resolveSetupToken(undefined);
    const second = resolveSetupToken(undefined);
    expect(first).toBe(second);
    expect(first.length).toBeGreaterThan(20);
  });

  it("rotates the auto token after reset", () => {
    const before = resolveSetupToken(undefined);
    resetSetupToken();
    const after = resolveSetupToken(undefined);
    expect(after).not.toBe(before);
  });
});

// --- Unit: first-boot logging ---

describe("logSetupTokenOnFirstBoot", () => {
  function spyLogger() {
    return {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    } as unknown as Container["logger"];
  }

  it("prints the auto-generated token exactly once when needsSetup", () => {
    const logger = spyLogger();
    logSetupTokenOnFirstBoot({ logger, needsSetup: true });
    logSetupTokenOnFirstBoot({ logger, needsSetup: true });
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const tokenLines = warn.mock.calls.filter((c: unknown[]) =>
      String(c[0]).includes("Setup token:"),
    );
    expect(tokenLines).toHaveLength(1);
  });

  it("does not print when an admin already exists", () => {
    const logger = spyLogger();
    logSetupTokenOnFirstBoot({ logger, needsSetup: false });
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const info = logger.info as unknown as ReturnType<typeof vi.fn>;
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("does not print the env token value, only a hint", () => {
    const logger = spyLogger();
    logSetupTokenOnFirstBoot({
      logger,
      needsSetup: true,
      envToken: "super-secret-env-token",
    });
    const info = logger.info as unknown as ReturnType<typeof vi.fn>;
    const warn = logger.warn as unknown as ReturnType<typeof vi.fn>;
    const allOutput = [...info.mock.calls, ...warn.mock.calls]
      .flat()
      .map(String)
      .join("\n");
    expect(allOutput).not.toContain("super-secret-env-token");
    expect(info).toHaveBeenCalled();
  });
});

// --- Integration: the sign-up gate ---

describe("first-admin sign-up gate (needsSetup true)", () => {
  it("rejects sign-up with NO setup token (anonymous land-grab)", async () => {
    const { app } = appWith({ userRows: [], envToken: "the-correct-token" });
    const res = await app.request("/api/auth/sign-up/email", signUpReq());
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Setup token");
  });

  it("rejects sign-up with a WRONG setup token", async () => {
    const { app } = appWith({ userRows: [], envToken: "the-correct-token" });
    const res = await app.request(
      "/api/auth/sign-up/email",
      signUpReq("the-wrong-token"),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("Setup token");
  });

  it("forwards sign-up with the CORRECT setup token", async () => {
    const { app, container } = appWith({
      userRows: [],
      envToken: "the-correct-token",
    });
    const res = await app.request(
      "/api/auth/sign-up/email",
      signUpReq("the-correct-token"),
    );
    expect(res.status).toBe(200);
    // The gate opened: better-auth's handler was invoked exactly once.
    expect(container.auth.handler).toHaveBeenCalledTimes(1);
  });
});

// --- Integration: brute-force throttle on the sign-up path ---

// The limiter prefers Redis and falls back to an in-memory store. CI may point
// REDIS_URL at a live (shared) instance whose `ratelimit:signup` keys outlive a
// run, so each test uses a UNIQUE client IP — the bucket key is per-IP, so a
// fresh random IP guarantees an empty window regardless of leftovers.
let ipSeq = 0;
function freshIp(): string {
  ipSeq += 1;
  // Unique-per-run x-forwarded-for value; the limiter keys on it verbatim, so
  // it need only be distinct, not a syntactically valid address.
  return `signup-test-${Date.now()}-${ipSeq}`;
}

describe("sign-up rate limit (setup-token guessing)", () => {
  it("returns 429 once an IP exceeds the per-window threshold", async () => {
    const { app } = appWith({ userRows: [], envToken: "the-correct-token" });
    const ip = freshIp();

    // 10/min is the configured budget; the 11th request from the same IP must
    // be throttled at the edge (429) BEFORE the setup-token gate runs.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await app.request(
        "/api/auth/sign-up/email",
        signUpReq("a-bad-guess", { ip }),
      );
      statuses.push(res.status);
    }

    // The first 10 bad guesses reach the gate (403); the 11th is rate-limited.
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    const throttled = statuses[10];
    expect(throttled).toBe(429);

    const res = await app.request(
      "/api/auth/sign-up/email",
      signUpReq("a-bad-guess", { ip }),
    );
    const body = await res.json();
    expect(res.status).toBe(429);
    expect(String(body.error).toLowerCase()).toContain("rate limit");
  });

  it("buckets per-IP — a different IP keeps its own fresh budget", async () => {
    const { app } = appWith({ userRows: [], envToken: "the-correct-token" });
    const attacker = freshIp();

    // Burn the attacker's budget.
    for (let i = 0; i < 11; i++) {
      await app.request(
        "/api/auth/sign-up/email",
        signUpReq("a-bad-guess", { ip: attacker }),
      );
    }
    const attackerRes = await app.request(
      "/api/auth/sign-up/email",
      signUpReq("a-bad-guess", { ip: attacker }),
    );
    expect(attackerRes.status).toBe(429);

    // A legit operator from a DIFFERENT IP is unaffected — the correct token
    // still opens the gate (200), proving the throttle didn't break the create.
    const { app: legitApp, container } = appWith({
      userRows: [],
      envToken: "the-correct-token",
    });
    const legitRes = await legitApp.request(
      "/api/auth/sign-up/email",
      signUpReq("the-correct-token", { ip: freshIp() }),
    );
    expect(legitRes.status).toBe(200);
    expect(container.auth.handler).toHaveBeenCalledTimes(1);
  });
});

describe("sign-up gate once an admin exists (needsSetup false)", () => {
  it("rejects sign-up regardless of any token", async () => {
    const { app, container } = appWith({
      userRows: [{ id: "existing-admin" }],
      envToken: "the-correct-token",
    });
    const res = await app.request(
      "/api/auth/sign-up/email",
      signUpReq("the-correct-token"),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toContain("closed");
    expect(container.auth.handler).not.toHaveBeenCalled();
  });
});

// --- Integration: /v1/auth/status never leaks the token ---

describe("GET /v1/auth/status", () => {
  it("returns only { needsSetup } and never the token", async () => {
    const { app } = appWith({ userRows: [], envToken: "the-correct-token" });
    const res = await app.request("/v1/auth/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body)).toEqual(["needsSetup"]);
    expect(body.needsSetup).toBe(true);
    expect(JSON.stringify(body)).not.toContain("the-correct-token");
  });
});
