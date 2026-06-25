import { describe, expect, it, vi } from "vitest";

// Enable the agent (fail-closed on the key) before the engine env loads.
process.env.OPENROUTER_API_KEY = "sk-or-test-only";

// ingestEvent (fire_event confirm) pushes to Hatchet — stub it like the other
// admin-route suites so the container builds without a live engine.
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

// In-memory Redis so the single-use burn is exercised hermetically (no live
// Redis, no port-guessing across local 6380 / CI 6379). Honors SET NX and the
// burn-Lua GET+DEL atomicity the proposal store relies on.
vi.mock("../lib/redis.js", () => {
  const store = new Map<string, string>();
  const redis = {
    set: async (
      key: string,
      val: string,
      _ex: string,
      _ttl: number,
      mode?: string,
    ) => {
      if (mode === "NX" && store.has(key)) return null;
      store.set(key, val);
      return "OK";
    },
    eval: async (_script: string, _numKeys: number, key: string) => {
      const v = store.get(key);
      if (v !== undefined) {
        store.delete(key);
        return v;
      }
      return null;
    },
  };
  return { getRedis: () => redis, getRedisIfConnected: () => redis };
});

const {
  createApp,
  createHogsendClient,
  mintProposal,
  verifyAndBurnProposal,
  InvalidProposalError,
} = await import("@hogsend/engine");

const SECRET = process.env.BETTER_AUTH_SECRET as string;
const app = createApp(createHogsendClient());
const AUTH = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

describe("proposal token — single-use burn + integrity", () => {
  it("round-trips then burns: second verify is rejected", async () => {
    const { token } = await mintProposal({
      secret: SECRET,
      tool: "fire_event",
      args: { event: "test.x", userId: "u1" },
      actorEmail: "op@test.local",
    });

    const first = await verifyAndBurnProposal({ token, secret: SECRET });
    expect(first.tool).toBe("fire_event");
    expect(first.args).toEqual({ event: "test.x", userId: "u1" });

    await expect(
      verifyAndBurnProposal({ token, secret: SECRET }),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it("rejects a tampered token", async () => {
    const { token } = await mintProposal({
      secret: SECRET,
      tool: "fire_event",
      args: {},
      actorEmail: "op@test.local",
    });
    const tampered = `${token.slice(0, -2)}${token.slice(-2) === "AA" ? "BB" : "AA"}`;
    await expect(
      verifyAndBurnProposal({ token: tampered, secret: SECRET }),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await mintProposal({
      secret: SECRET,
      tool: "delete_contact",
      args: { email: "x@y.z" },
      actorEmail: "op@test.local",
    });
    await expect(
      verifyAndBurnProposal({
        token,
        secret: "a-totally-different-secret-32ch+",
      }),
    ).rejects.toBeInstanceOf(InvalidProposalError);
  });
});

describe("POST /v1/admin/agent/confirm — auth + token rejections", () => {
  it("401s without a key or session", async () => {
    const res = await app.request("/v1/admin/agent/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "x" }),
    });
    expect(res.status).toBe(401);
  });

  it("400s when no token is supplied", async () => {
    const res = await app.request("/v1/admin/agent/confirm", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("410s on a malformed/garbage token", async () => {
    const res = await app.request("/v1/admin/agent/confirm", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ token: "not-a-real-token" }),
    });
    expect(res.status).toBe(410);
  });

  it("403s when the confirming actor didn't mint the proposal", async () => {
    const { token } = await mintProposal({
      secret: SECRET,
      tool: "fire_event",
      args: { event: "test.x" },
      actorEmail: "someone-else@test.local",
    });
    const res = await app.request("/v1/admin/agent/confirm", {
      method: "POST",
      headers: { ...AUTH, "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(403);
  });
});
