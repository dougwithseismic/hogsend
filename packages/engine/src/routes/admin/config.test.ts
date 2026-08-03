import assert from "node:assert/strict";
import { type AddressInfo, createServer } from "node:net";
import { after, before, test } from "node:test";
import type { AppEnv } from "../../app.js";
import type { HogsendClient } from "../../container.js";

// env.ts validates process.env ONCE at first import, so the boot contract must
// be in place BEFORE any engine module loads — hence the dynamic imports below
// (static imports would hoist above these assignments). The dummy JWT exists
// because modules in the admin import graph decode HATCHET_CLIENT_TOKEN at
// module scope (lib/hatchet.ts) but never connect.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test";
process.env.BETTER_AUTH_SECRET =
  "test-secret-for-node-test-minimum-32-characters";
process.env.HATCHET_CLIENT_TOKEN =
  "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test";

const { OpenAPIHono } = await import("@hono/zod-openapi");
const { getBootDiagnostics, recordBootDiagnostic } = await import(
  "../../lib/boot-diagnostics.js"
);
const { getRedisIfConnected } = await import("../../lib/redis.js");
const { adminRouter } = await import("./index.js");

// The whole point of the split: text like this (naming an env var) is
// admin-only. AC9 asserts it IS listed here, code and message intact.
const SENTINEL_A = {
  code: "test.admin-config-sentinel-a",
  message: "sentinel A naming TEST_ADMIN_SENTINEL_A_ENV_VAR",
};
const SENTINEL_B = {
  code: "test.admin-config-sentinel-b",
  message: "sentinel B naming TEST_ADMIN_SENTINEL_B_ENV_VAR",
};
const SENTINELS = [SENTINEL_A, SENTINEL_B];

// AC15: an entry that exists ONLY in the worker process's collector and
// reaches this route via the Redis heartbeat payload.
const WORKER_SENTINEL = {
  code: "test.admin-config-worker-sentinel",
  message: "worker sentinel naming TEST_ADMIN_WORKER_ENV_VAR",
};

// ---- Minimal RESP stub standing in for Redis -------------------------------
//
// The config route now reads the worker heartbeat (worker diagnostics ride
// its payload), and it does so through the module-level ioredis singleton —
// no injection seam — so the stub answers the wire protocol: INFO (ioredis'
// ready check) and GET (the heartbeat key, served from `heartbeatValue`).
// Same harness as routes/health.config.test.ts.
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

const redisStub = createServer((socket) => {
  socket.on("data", (buf) => {
    const commands = buf.toString().toLowerCase().split("*").slice(1);
    socket.write(commands.map(respReply).join(""));
  });
});

before(async () => {
  await new Promise<void>((resolve) => {
    redisStub.listen(0, "127.0.0.1", resolve);
  });
  const { port } = redisStub.address() as AddressInfo;
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

// Mount the REAL adminRouter (not the config router in isolation) so the test
// proves registration AND guard inheritance: an unregistered route or a route
// mounted outside the router's `use("*", requireAdmin)` both go red here.
// requireAdmin's session path reads `auth` off the container; GET requests
// skip the audit write and the rate limiter no-ops under NODE_ENV=test.
function appWithSession(
  session: { user: { id: string }; session: { id: string } } | null,
) {
  const container = {
    auth: { api: { getSession: async () => session } },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  } as unknown as HogsendClient;
  const app = new OpenAPIHono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("container", container);
    await next();
  });
  app.route("/", adminRouter);
  return app;
}

const ADMIN_SESSION = {
  user: { id: "admin-user" },
  session: { id: "admin-session" },
};

test("AC8: GET /config without admin auth → the router's standard 401", async () => {
  const res = await appWithSession(null).request("/config");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("AC9: GET /config with admin auth lists every diagnostic, code + message", async () => {
  for (const s of SENTINELS) {
    recordBootDiagnostic(s);
  }

  const res = await appWithSession(ADMIN_SESSION).request("/config");
  assert.equal(res.status, 200);
  const body = await res.json();

  // The full collector, verbatim, tagged as this (API) process's —
  // collector-relative, never an absolute count (the collector is
  // process-global state). No heartbeat payload is seeded here, so no
  // worker entries appear.
  assert.deepEqual(
    body.warnings,
    getBootDiagnostics().map((d) => ({ ...d, process: "api" })),
  );
  // And the sentinels are demonstrably in it with their text intact.
  for (const s of SENTINELS) {
    assert.deepEqual(
      body.warnings.find(
        (w: { code: string; message: string }) => w.code === s.code,
      ),
      { ...s, process: "api" },
    );
  }
});

test("AC15: worker diagnostics are listed, tagged with their process", async () => {
  recordBootDiagnostic(SENTINEL_A);
  // The worker publishes its collector on the heartbeat payload: one entry
  // only the worker saw, plus a re-report of a code the API also recorded.
  heartbeatValue = JSON.stringify({
    lastSeenAt: "2026-07-25T12:00:00.000Z",
    diagnostics: [
      WORKER_SENTINEL,
      { code: SENTINEL_A.code, message: SENTINEL_A.message },
    ],
  });

  const res = await appWithSession(ADMIN_SESSION).request("/config");
  assert.equal(res.status, 200);
  const body = await res.json();

  // The worker-only entry arrives with code AND message intact, tagged.
  assert.deepEqual(
    body.warnings.find(
      (w: { code: string }) => w.code === WORKER_SENTINEL.code,
    ),
    { ...WORKER_SENTINEL, process: "worker" },
  );

  // A code recorded in BOTH processes appears as TWO rows — one per process.
  // Railway env is per-service, so the tag tells the operator WHICH
  // service's env to fix; /v1/health is where the union-dedupe happens.
  const shared = body.warnings.filter(
    (w: { code: string }) => w.code === SENTINEL_A.code,
  );
  assert.deepEqual(shared.map((w: { process: string }) => w.process).sort(), [
    "api",
    "worker",
  ]);
});

test("AC15 degradation: absent or malformed heartbeat payload → API-only view", async () => {
  heartbeatValue = '{"diagnostics": broken json';
  const malformed = await appWithSession(ADMIN_SESSION).request("/config");
  assert.equal(malformed.status, 200);
  const malformedBody = await malformed.json();
  assert.ok(
    malformedBody.warnings.every(
      (w: { process: string }) => w.process === "api",
    ),
    "malformed worker payload must degrade to the API-only view",
  );

  heartbeatValue = null;
  const absent = await appWithSession(ADMIN_SESSION).request("/config");
  assert.equal(absent.status, 200);
  const absentBody = await absent.json();
  assert.ok(
    absentBody.warnings.every((w: { process: string }) => w.process === "api"),
    "absent worker payload must degrade to the API-only view",
  );
});
