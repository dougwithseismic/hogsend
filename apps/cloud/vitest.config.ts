import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Mirrors the tsconfig `@/*` path so route handlers (which Next resolves via
  // that alias) are importable directly from tests.
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Migrations touch a real database and hold an advisory lock; the default
    // 5s timeout flakes on a cold connection + CREATE DATABASE.
    testTimeout: 60_000,
    // Every suite hits the same real Postgres; parallel files race fixtures
    // and stack connection pools against the server's max_connections when
    // turbo runs the whole monorepo. The suite is ~4s — serialize it.
    fileParallelism: false,
    env: {
      NODE_ENV: "test",
      // LAW: the default MUST be port 5434 — the repo's docker-compose
      // TimescaleDB — so CI works with no local env exported. An exported
      // CLOUD_DATABASE_URL on a dev machine would otherwise mask a wrong
      // default and turn CI red with ECONNREFUSED.
      CLOUD_DATABASE_URL:
        "postgres://growthhog:growthhog@localhost:5434/hogsend_cloud",
    },
  },
});
