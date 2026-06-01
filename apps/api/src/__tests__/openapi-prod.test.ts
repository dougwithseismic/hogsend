import { createApp, createHogsendClient } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

/**
 * Regression lock for the prod docs gate at packages/engine/src/app.ts
 * (`if (container.env.NODE_ENV !== "production")`). The OpenAPI spec and the
 * Scalar `/docs` UI must be mounted in dev/test but NOT in production, so a
 * future engine change can't silently expose the API surface in prod.
 *
 * `createApp` reads only `container.env.NODE_ENV` for this gate, so we clone the
 * container with an overridden `env` rather than mutating the shared singleton.
 */
function appWithNodeEnv(nodeEnv: string) {
  const container = createHogsendClient();
  return createApp({
    ...container,
    env: { ...container.env, NODE_ENV: nodeEnv } as typeof container.env,
  });
}

describe("OpenAPI docs gate — production", () => {
  const app = appWithNodeEnv("production");

  it("returns 404 for /openapi.json", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(404);
  });

  it("returns 404 for /docs", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(404);
  });
});

describe("OpenAPI docs gate — non-production", () => {
  const app = appWithNodeEnv("development");

  it("serves /openapi.json as JSON", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
  });

  it("serves /docs", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
  });
});
