import assert from "node:assert/strict";
import { test } from "node:test";
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
const { adminRouter } = await import("./index.js");

// The whole point of the split: text like this (naming an env var) is
// admin-only. AC9 asserts it IS listed here, code and message intact.
const SENTINELS = [
  {
    code: "test.admin-config-sentinel-a",
    message: "sentinel A naming TEST_ADMIN_SENTINEL_A_ENV_VAR",
  },
  {
    code: "test.admin-config-sentinel-b",
    message: "sentinel B naming TEST_ADMIN_SENTINEL_B_ENV_VAR",
  },
];

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

test("AC8: GET /config without admin auth → the router's standard 401", async () => {
  const res = await appWithSession(null).request("/config");
  assert.equal(res.status, 401);
  assert.deepEqual(await res.json(), { error: "Unauthorized" });
});

test("AC9: GET /config with admin auth lists every diagnostic, code + message", async () => {
  for (const s of SENTINELS) {
    recordBootDiagnostic(s);
  }

  const res = await appWithSession({
    user: { id: "admin-user" },
    session: { id: "admin-session" },
  }).request("/config");
  assert.equal(res.status, 200);
  const body = await res.json();

  // The full collector, verbatim — collector-relative, never an absolute
  // count (the collector is process-global state).
  assert.deepEqual(body.warnings, getBootDiagnostics());
  // And the sentinels are demonstrably in it with their text intact.
  for (const s of SENTINELS) {
    assert.deepEqual(
      body.warnings.find(
        (w: { code: string; message: string }) => w.code === s.code,
      ),
      s,
    );
  }
});
