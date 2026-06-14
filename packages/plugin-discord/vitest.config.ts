import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    globals: true,
    include: ["src/__tests__/**/*.test.ts"],
    // `@hogsend/engine` ships raw `.ts` with `.js` relative specifiers (ESM
    // resolution). Inlining it lets Vite resolve those to their `.ts` sources
    // (the connector/destination tests import the engine's authoring layer).
    server: {
      deps: {
        inline: [/@hogsend\/engine/],
      },
    },
    // Importing the engine barrel eagerly validates `env.ts` (it calls
    // createEnv at module load). Inject the minimal vars so the import resolves
    // — mirrors apps/api/vitest.config.ts. The Discord tests never touch a DB
    // or Hatchet; these only satisfy the boot-time schema.
    env: {
      NODE_ENV: "test",
      PORT: "3002",
      LOG_LEVEL: "error",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "test-secret-for-vitest-minimum-32-characters-long",
      BETTER_AUTH_URL: "http://localhost:3002",
      API_PUBLIC_URL: "http://localhost:3002",
      HATCHET_CLIENT_TOKEN:
        "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test",
    },
  },
});
