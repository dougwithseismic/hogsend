import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `@hogsend/engine` ships raw `.ts` and uses `.js` extensions in its
    // relative imports (ESM resolution). Inlining it lets Vite's transform
    // pipeline resolve those `.js` specifiers to their `.ts` sources instead
    // of leaving them to Node's resolver (which fails on `./app.js`).
    server: {
      deps: {
        inline: [/@hogsend\/engine/],
      },
    },
    env: {
      NODE_ENV: "test",
      PORT: "3002",
      LOG_LEVEL: "error",
      DATABASE_URL: "postgresql://test:test@localhost:5432/test",
      REDIS_URL: "redis://localhost:6379",
      BETTER_AUTH_SECRET: "test-secret-for-vitest-minimum-32-characters-long",
      BETTER_AUTH_URL: "http://localhost:3002",
      RESEND_API_KEY: "re_test_000000000000000000000000",
      RESEND_WEBHOOK_SECRET: "whsec_test_secret_for_vitest",
      API_PUBLIC_URL: "http://localhost:3002",
      ADMIN_API_KEY: "test-admin-api-key",
      HATCHET_CLIENT_TOKEN:
        "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test",
    },
  },
});
