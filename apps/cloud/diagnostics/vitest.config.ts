import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone vitest project for the relocated SES diagnostic harnesses. It
// mirrors the app's test-env injection (apps/cloud/vitest.config.ts) verbatim
// because the delivery-proof test imports ../../src/db + ../../src/db/migrator
// and hits the same real Postgres. The `@` alias resolves to the app root
// (one level up) so app files pulled in via relative import keep resolving.
export default defineConfig({
  // Root is this diagnostics dir (not the cwd apps/cloud), so `test.include`
  // below resolves against diagnostics/test rather than apps/cloud/test.
  root: fileURLToPath(new URL(".", import.meta.url)),
  resolve: {
    alias: { "@": fileURLToPath(new URL("../", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Migrations touch a real database and hold an advisory lock; the default
    // 5s timeout flakes on a cold connection + CREATE DATABASE.
    testTimeout: 60_000,
    // Every suite hits the same real Postgres; parallel files race fixtures
    // and stack connection pools against the server's max_connections when
    // turbo runs the whole monorepo. Serialize it.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // Never start a build in-process as a publish side effect.
      CLOUD_INLINE_BUILDS: "off",
      // LAW: the default MUST be port 5434 — the repo's docker-compose
      // TimescaleDB — so CI works with no local env exported.
      CLOUD_DATABASE_URL:
        process.env.HOGSEND_CLOUD_TEST_DATABASE_URL ??
        "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud",
    },
  },
});
