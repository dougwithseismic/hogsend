import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Placeholder env so tests can import modules that load the engine's MAIN
    // entry (src/buckets/* do — `defineBucket`/`refineContact` live there,
    // unlike journeys, which import the env-free `@hogsend/engine/journeys`).
    // The main entry validates env at import time; these values only need to
    // parse — nothing is dialled. The HATCHET_CLIENT_TOKEN is a fake JWT
    // carrying the `server_url`/`grpc_broadcast_address` claims the SDK reads
    // at client construction (the connection itself is lazy).
    env: {
      NODE_ENV: "test",
      LOG_LEVEL: "error",
      DATABASE_URL: "postgresql://placeholder:placeholder@localhost:5434/test",
      BETTER_AUTH_SECRET: "placeholder-secret-for-tests-minimum-32-chars",
      HATCHET_CLIENT_TOKEN:
        "eyJhbGciOiJFUzI1NiIsImtpZCI6InRlc3QifQ.eyJhdWQiOiJsb2NhbGhvc3QiLCJleHAiOjQ5MzMyNDA5ODMsImdycGNfYnJvYWRjYXN0X2FkZHJlc3MiOiJsb2NhbGhvc3Q6NzA3NyIsImlhdCI6MTc3OTY0MDk4MywiaXNzIjoibG9jYWxob3N0Iiwic2VydmVyX3VybCI6ImxvY2FsaG9zdCIsInN1YiI6InRlc3QtdGVuYW50LWlkIiwidG9rZW5faWQiOiJ0ZXN0LXRva2VuLWlkIn0.test",
    },
    // `@hogsend/engine` ships raw `.ts` and uses `.js` extensions in its
    // relative imports (ESM resolution). Inlining it lets Vite's transform
    // pipeline resolve those `.js` specifiers to their `.ts` sources instead
    // of leaving them to Node's resolver (which fails on `./app.js`).
    server: {
      deps: {
        inline: [/@hogsend\/(core|email|engine|sms|testing)/],
      },
    },
  },
});
