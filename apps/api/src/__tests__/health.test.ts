import { API_VERSION, createApp, createHogsendClient } from "@hogsend/engine";
import { describe, expect, it } from "vitest";

const container = createHogsendClient();
const app = createApp(container);

describe("GET /v1/health", () => {
  it("returns health status with components", async () => {
    const res = await app.request("/v1/health");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(["healthy", "degraded", "migration_pending"]).toContain(body.status);
    expect(body.version).toBe(API_VERSION);
    expect(body.uptime).toBeTypeOf("number");
    expect(body.timestamp).toBeTruthy();
    expect(body.components).toBeDefined();
    expect(body.components.database).toBeDefined();
    expect(body.components.redis).toBeDefined();
  });

  it("includes request-id header", async () => {
    const res = await app.request("/v1/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("forwards provided request-id", async () => {
    const res = await app.request("/v1/health", {
      headers: { "x-request-id": "test-123" },
    });
    expect(res.headers.get("x-request-id")).toBe("test-123");
  });

  it("includes security headers", async () => {
    const res = await app.request("/v1/health");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
});

describe("404 handling", () => {
  it("returns JSON for unknown routes", async () => {
    const res = await app.request("/nonexistent");
    expect(res.status).toBe(404);

    const body = await res.json();
    expect(body.error).toBe("Not Found");
  });

  it("returns 404 for unversioned health path", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(404);
  });
});

describe("OpenAPI", () => {
  it("serves spec at /openapi.json", async () => {
    const res = await app.request("/openapi.json");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.openapi).toBe("3.1.0");
    expect(body.info.version).toBe(API_VERSION);
    expect(body.paths["/v1/health"]).toBeDefined();
  });

  it("serves Scalar docs at /docs", async () => {
    const res = await app.request("/docs");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });
});

describe("CORS", () => {
  it("handles preflight requests", async () => {
    const res = await app.request("/v1/health", {
      method: "OPTIONS",
      headers: {
        Origin: "http://example.com",
        "Access-Control-Request-Method": "GET",
      },
    });
    expect(res.status).toBe(204);
    // CORS now REFLECTS the request Origin (echoes it back) rather than the
    // blanket `*`, so a browser can read responses for pk_ publishable-key
    // ingest from a specific first-party origin. The security boundary is NOT
    // here — it is the per-key Origin allowlist enforced in
    // `requirePublishableOrIngest` on the real request. An Origin-less request
    // (same-origin / server SDK) still gets `*`.
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://example.com",
    );
  });
});
