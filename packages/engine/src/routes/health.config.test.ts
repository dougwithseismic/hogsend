import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Socket } from "node:net";
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
// worker heartbeat — answered with `heartbeatValue`, which the AC15 tests set
// to a worker-published JSON payload; null → "not set" → worker "down",
// which is informational and never touches status).
let heartbeatValue: string | null = null;

function bulk(s: string): string {
  return `$${Buffer.byteLength(s)}\r\n${s}\r\n`;
}

function respReply(command: string): string {
  if (command.includes("info")) return bulk("redis_version:7.4.0\r\n");
  if (command.includes("ping")) return "+PONG\r\n";
  if (command.includes("get")) {
    return heartbeatValue === null ? "$-1\r\n" : bulk(heartbeatValue);
  }
  return "+OK\r\n";
}

// Live sockets are tracked so the Redis-unreachable test can sever them —
// server.close() alone waits politely for open connections.
const stubSockets = new Set<Socket>();

const redisStub = createServer((socket) => {
  stubSockets.add(socket);
  socket.on("close", () => stubSockets.delete(socket));
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

// ---- T7 / AC15: worker diagnostics ride the heartbeat ----------------------
//
// The collector is per-OS-process memory and only the API process serves
// HTTP; worker-side credentials (TWILIO_*, APOLLO_API_KEY) record into a
// collector nothing could read — #611's exact blind spot. The worker
// publishes its collector on the Redis heartbeat payload; /v1/health must
// MERGE it into the public count.

const WORKER_ONLY = {
  code: "test.worker-only-sentinel",
  message: "worker-only diagnostic naming TEST_WORKER_SENTINEL_ENV_VAR",
};

test("AC15: /v1/health merges API + worker warnings union-by-code", async () => {
  // Known-empty collector (safe here — own process, nothing below relies on
  // module-scope loader recordings), then exactly one API-side entry.
  clearBootDiagnostics();
  recordBootDiagnostic(SENTINEL);

  // The worker re-reports the SAME code (both processes detect the same
  // misconfiguration) plus one worker-only code.
  heartbeatValue = JSON.stringify({
    lastSeenAt: "2026-07-25T12:00:00.000Z",
    diagnostics: [
      { code: SENTINEL.code, message: "worker copy of the shared problem" },
      WORKER_ONLY,
    ],
  });

  const res = await app.request("/");
  assert.equal(res.status, 200);
  const raw = await res.text();
  const body = JSON.parse(raw);

  // UNION by code, computed independently of the implementation: the shared
  // code is ONE problem seen from two processes. A SUM would report 3 and
  // must fail here; the honest merged count is 2.
  const expectedUnion = new Set([
    ...getBootDiagnostics().map((d) => d.code),
    SENTINEL.code,
    WORKER_ONLY.code,
  ]);
  assert.equal(body.config.warnings, expectedUnion.size);
  assert.equal(body.config.warnings, 2);

  // The JSON payload still carries the liveness contract.
  assert.equal(body.components.worker.status, "up");
  assert.equal(body.components.worker.lastSeenAt, "2026-07-25T12:00:00.000Z");

  // AC6 extends to WORKER text: the merged COUNT is public, the merged
  // DETAIL is admin-only. Worker messages must not leak onto this route.
  assert.ok(
    !raw.includes(WORKER_ONLY.message),
    "worker diagnostic message leaked onto unauthenticated /v1/health",
  );
  assert.ok(
    !raw.includes("TEST_WORKER_SENTINEL_ENV_VAR"),
    "worker diagnostic env-var name leaked onto unauthenticated /v1/health",
  );
  assert.ok(
    !raw.includes(WORKER_ONLY.code),
    "worker diagnostic code leaked onto unauthenticated /v1/health",
  );
});

test("AC15 degradation: absent heartbeat payload → API-only count", async () => {
  heartbeatValue = null;
  const res = await app.request("/");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.warnings, getBootDiagnostics().length);
  assert.equal(body.components.worker.status, "down");
});

test("AC15 degradation: legacy bare-timestamp payload → liveness only, API-only count", async () => {
  // A pre-diagnostics worker still writes the bare ISO string (mixed-version
  // deploy window): liveness must keep working, count degrades to API-only.
  heartbeatValue = "2026-07-25T09:00:00.000Z";
  const res = await app.request("/");
  const body = await res.json();
  assert.equal(body.components.worker.status, "up");
  assert.equal(body.components.worker.lastSeenAt, heartbeatValue);
  assert.equal(body.config.warnings, getBootDiagnostics().length);
});

test("AC15 degradation: malformed heartbeat payload → API-only count, no throw", async () => {
  heartbeatValue = '{"lastSeenAt": definitely broken';
  const res = await app.request("/");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.warnings, getBootDiagnostics().length);
});

// LAST on purpose: it takes the stub down for good.
test("AC15 degradation: Redis unreachable → API-only count, no throw", async () => {
  const closed = new Promise<void>((resolve) => {
    redisStub.close(() => resolve());
  });
  for (const s of stubSockets) {
    s.destroy();
  }
  await closed;

  const res = await app.request("/");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.config.warnings, getBootDiagnostics().length);
  assert.equal(body.components.worker.status, "down");
});
