import assert from "node:assert/strict";
import { type AddressInfo, createServer } from "node:net";
import { after, before, test } from "node:test";
import type { AppEnv } from "../app.js";
import type { HogsendClient } from "../container.js";

// env.ts validates process.env ONCE at first import, so the boot contract must
// be in place BEFORE any engine module loads — hence the dynamic imports below
// (static imports would hoist above these assignments). Type-only imports are
// erased and safe to keep static.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET =
  "test-secret-for-node-test-minimum-32-characters";
// Required by env.ts; the same structurally-valid dummy JWT the other engine
// suites use — decoded at module scope, never connected to.
process.env.HATCHET_CLIENT_TOKEN =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { getBundledMigrations } = await import("@hogsend/db");
const { clearBootDiagnostics, getBootDiagnostics, recordBootDiagnostic } =
  await import("../lib/boot-diagnostics.js");
const { getRedisIfConnected } = await import("../lib/redis.js");
const { healthRouter } = await import("./health.js");

// A sentinel whose message deliberately looks like the real diagnostics
// (naming an env var) — AC6 asserts none of it ever serializes onto the
// UNAUTHENTICATED /v1/health body. Count only; text is reconnaissance.
const SENTINEL = {
  code: "test.health-config-sentinel",
  message:
    "sentinel diagnostic naming TEST_HEALTH_SENTINEL_ENV_VAR — admin-only text",
};

// ---- Minimal RESP stub standing in for Redis -------------------------------
//
// AC7 needs a truthfully-HEALTHY baseline (all components up), else the
// "warnings never move status" assertion can't distinguish the advisory rule
// from an environment that was degraded anyway. The health route probes Redis
// through the module-level ioredis singleton (lib/redis.ts) — no injection
// seam — so the only infra-free way to an honest "up" is answering the wire
// protocol: INFO (ioredis' ready check), PING (the component probe), GET (the
// worker heartbeat, answered "not set" → worker "down", which is
// informational and never touches status).
function respReply(command: string): string {
  if (command.includes("info")) {
    const info = "redis_version:7.4.0\r\n";
    return `$${Buffer.byteLength(info)}\r\n${info}\r\n`;
  }
  if (command.includes("ping")) return "+PONG\r\n";
  if (command.includes("get")) return "$-1\r\n";
  return "+OK\r\n";
}

const redisStub = createServer((socket) => {
  socket.on("data", (buf) => {
    // Each chunk carries one-or-more RESP command arrays
    // ("*N\r\n$len\r\narg…"); answer each in arrival order. Splitting on the
    // array marker is crude but sufficient — the only commands on this wire
    // are info/ping/get, and no argument contains "*".
    const commands = buf.toString().toLowerCase().split("*").slice(1);
    socket.write(commands.map(respReply).join(""));
  });
});

before(async () => {
  await new Promise<void>((resolve) => {
    redisStub.listen(0, "127.0.0.1", resolve);
  });
  const { port } = redisStub.address() as AddressInfo;
  // getRedis() reads REDIS_URL lazily on the first command (the first request
  // below), so setting it here — after import, before any request — is safe.
  process.env.REDIS_URL = `redis://127.0.0.1:${port}`;
});

after(async () => {
  // The ioredis singleton would otherwise hold the event loop open and hang
  // the test process.
  getRedisIfConnected()?.disconnect();
  await new Promise<void>((resolve) => {
    redisStub.close(() => resolve());
  });
});

// ---- Fake container --------------------------------------------------------
//
// The handler reads only { db, clientJournal } off the container. Every
// `execute` answers with the bundled-migration count, which satisfies both
// callers: the `SELECT 1` component probe ignores its result, and the engine
// ledger COUNT then reads as fully applied → inSync (the client track's
// journal defaults to empty → trivially inSync). `select` (the activity
// COUNTs) throws synchronously, which queryRecentActivity's try/catch
// degrades to nulls — activity is informational and irrelevant here.
const fakeDb = {
  execute: async () => [{ count: getBundledMigrations().length }],
  select(): never {
    throw new Error("activity queries are degraded-to-null in this fake");
  },
};

const app = new OpenAPIHono<AppEnv>();
app.use("*", async (c, next) => {
  c.set("container", { db: fakeDb } as unknown as HogsendClient);
  await next();
});
app.route("/", healthRouter);

test("AC5+AC7: config.warnings tracks the collector; status never moves", async () => {
  // Start from a known-empty collector so the status-participation mutation
  // (warnings > 0 → degraded) is detectable: the baseline must see ZERO
  // warnings, the follow-up exactly one. Safe in this file — it runs in its
  // own process and nothing below relies on module-scope loader recordings.
  clearBootDiagnostics();

  const first = await app.request("/");
  assert.equal(first.status, 200);
  const firstBody = await first.json();
  assert.equal(firstBody.status, "healthy");
  assert.equal(firstBody.config.warnings, getBootDiagnostics().length);

  recordBootDiagnostic(SENTINEL);

  const second = await app.request("/");
  const secondBody = await second.json();
  // Delta + collector-relative — never an absolute count (the collector is
  // process-global state).
  assert.equal(secondBody.config.warnings, firstBody.config.warnings + 1);
  assert.equal(secondBody.config.warnings, getBootDiagnostics().length);
  // AC7: a config warning is advisory. Turning it into "degraded" would fail
  // Railway's healthcheck and convert an advisory into an outage.
  assert.equal(secondBody.status, "healthy");
});

test("AC6: the serialized body carries the count and none of the text", async () => {
  recordBootDiagnostic(SENTINEL);

  const res = await app.request("/");
  const raw = await res.text();
  assert.ok(
    !raw.includes(SENTINEL.message),
    "diagnostic message text leaked onto unauthenticated /v1/health",
  );
  assert.ok(
    !raw.includes("TEST_HEALTH_SENTINEL_ENV_VAR"),
    "diagnostic env-var name leaked onto unauthenticated /v1/health",
  );
  assert.ok(
    !raw.includes(SENTINEL.code),
    "diagnostic code leaked onto unauthenticated /v1/health",
  );
});
