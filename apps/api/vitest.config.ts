import { configDefaults, defineConfig } from "vitest/config";

// All DB-backed suites share ONE docker TimescaleDB. Most isolate via
// RUN-namespaced rows, but outbound-webhook emit is a GLOBAL fan-out: it
// selects every `organizationId IS NULL` endpoint and writes a delivery row
// per match. So a contact upsert / email send in one file can write rows to
// a webhook endpoint another file is asserting on (and vice-versa) — a
// side effect RUN-namespacing cannot scope. Only the files below touch those
// global webhook tables; they run in their own serial project AFTER the rest
// of the suite (the groupOrder barrier below), so no other file mutates the
// shared webhook tables while they run. Everything else runs file-parallel.
// Re-derive on drift:
//   rg -l "outboundWebhook|webhookEndpoint|emitOutbound" src/__tests__
const WEBHOOK_FANOUT = [
  "src/__tests__/destinations.test.ts",
  "src/__tests__/groups-outbound.test.ts",
  "src/__tests__/impact-digest.test.ts",
  "src/__tests__/link-tracker-email-invariant.test.ts",
  "src/__tests__/outbound-webhooks-delivery.test.ts",
  "src/__tests__/outbound-webhooks-emit.test.ts",
  "src/__tests__/outbound-webhooks-routes.test.ts",
  "src/__tests__/phase2-posthog-destination.test.ts",
  "src/__tests__/posthog-person-sync.test.ts",
  "src/__tests__/sms-consent.test.ts",
  "src/__tests__/sms-link-click.test.ts",
  // Not a webhook file — the global-control readout scans the WHOLE
  // contacts table and its parity oracle recomputes the same scan, a
  // comparison RUN-namespacing cannot scope. It needs the same serial
  // barrier (no other file mutating contacts mid-comparison).
  "src/__tests__/admin-impact-global-control.test.ts",
  // Also not a webhook file, same reason one layer down: the backfill's
  // "physically untouched" assertions compare Postgres `xmin` (tuple version)
  // before and after a re-drive, and ANY concurrent write to those rows bumps
  // xmin. RUN-namespacing scopes the rows this file creates, not the tuple
  // versions another file's writes advance. Measured 2026-08-12: 3 failures
  // file-parallel, 20/20 green run alone.
  "src/__tests__/contact-id-backfill.test.ts",
];

export default defineConfig({
  // Dedupe React so `@hogsend/react`'s `react` import and the test's `react-dom`
  // share ONE copy — otherwise two dispatcher instances (hooks) collide and
  // `useState` reads null. (apps/api pins react + react-dom to one version.)
  resolve: { dedupe: ["react", "react-dom"] },
  test: {
    environment: "node",
    // With file-parallel workers the default 5s testTimeout flakes on tests
    // that dynamically `await import("@hogsend/engine")` inside the test body —
    // the transform+import of the inlined engine graph can exceed 5s under
    // full-core contention. 30s keeps real hangs failing while removing the
    // load-induced false negatives.
    testTimeout: 30_000,
    // `@hogsend/engine` ships raw `.ts` and uses `.js` extensions in its
    // relative imports (ESM resolution). Inlining it lets Vite's transform
    // pipeline resolve those `.js` specifiers to their `.ts` sources instead
    // of leaving them to Node's resolver (which fails on `./app.js`).
    server: {
      deps: {
        // `@hogsend/engine` AND `@hogsend/mcp` ship raw `.ts` with `.js`-suffixed
        // relative imports; inlining lets Vite's transform resolve those to the
        // `.ts` sources (the mcp-http integration suite loads `@hogsend/mcp`).
        inline: [/@hogsend\/(engine|mcp)/],
      },
    },
    env: {
      NODE_ENV: "test",
      PORT: "3002",
      LOG_LEVEL: "error",
      // LAW: these default to the repo's OWN docker-compose services (Postgres
      // 5434, Redis 6380) so a clean checkout works with nothing exported.
      // Both were on the DEFAULT ports (5432 / 6379), which this repo never
      // starts — so on a developer machine they resolve to whatever unrelated
      // container happens to hold that port.
      //
      // REDIS_URL is the one that bit. NO test file sets it (all 192 DB-backed
      // files assign DATABASE_URL themselves at module top-level, none assign
      // this), so the value here is the value the suite uses. It pointed at
      // 6379, which on this machine was another project's Redis container, and
      // the suite used it. Measured 2026-08-12: with Redis unreachable, 12
      // tests across 5 files fail; against 6380 the suite is green. Those 12
      // are why a config nobody had looked at could quietly matter.
      //
      // DATABASE_URL here is mostly belt-and-braces: the 192 files that touch
      // Postgres already default to 5434 and already honour
      // HOGSEND_TEST_DATABASE_URL, so this line only governs the files that do
      // not set it. It is corrected to agree with them rather than contradict
      // them — a config that names a different database than every test file
      // is a trap even when it is inert.
      //
      // `test.env` OVERRIDES the ambient process.env (measured, not assumed —
      // an exported REDIS_URL does NOT win), so an exported var cannot be the
      // escape hatch and a dedicated one is required. Hence the two
      // HOGSEND_TEST_* vars, mirroring the cloud suite's
      // HOGSEND_CLOUD_TEST_DATABASE_URL.
      DATABASE_URL:
        process.env.HOGSEND_TEST_DATABASE_URL ??
        "postgresql://growthhog:growthhog@localhost:5434/growthhog",
      REDIS_URL: process.env.HOGSEND_TEST_REDIS_URL ?? "redis://localhost:6380",
      BETTER_AUTH_SECRET: "test-secret-for-vitest-minimum-32-characters-long",
      BETTER_AUTH_URL: "http://localhost:3002",
      RESEND_API_KEY: "re_test_000000000000000000000000",
      RESEND_WEBHOOK_SECRET: "whsec_test_secret_for_vitest",
      // A webhook-preset secret so the env preset (stripe) auto-mounts in the
      // container's connector registry — lets the connectors semver-hygiene
      // test assert that `enablePresets: false` strips it while the default
      // (presets enabled) mounts it.
      STRIPE_WEBHOOK_SECRET: "whsec_stripe_test_secret_for_vitest",
      API_PUBLIC_URL: "http://localhost:3002",
      ADMIN_API_KEY: "test-admin-api-key",
      HATCHET_CLIENT_TOKEN:
        "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test",
    },
    projects: [
      {
        // `extends: true` inherits everything above (env, server.deps.inline,
        // resolve.dedupe). A project-level `exclude` REPLACES the inherited
        // default excludes (node_modules etc.), so configDefaults.exclude is
        // re-spread here.
        extends: true,
        test: {
          name: "main",
          include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
          exclude: [...configDefaults.exclude, ...WEBHOOK_FANOUT],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "webhook-fanout",
          include: WEBHOOK_FANOUT,
          // Strictly AFTER all of "main": vitest runs groupOrder groups
          // sequentially — a group fully completes before the next starts.
          sequence: { groupOrder: 1 },
          // One worker at a time => these files run serially among themselves.
          // isolate stays true (default): several of these files mutate
          // process.env at module top-level and rely on a fresh module graph
          // per file (the engine parses env once at first import).
          maxWorkers: 1,
        },
      },
    ],
  },
});
