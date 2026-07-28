import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as healthGET } from "../../app/api/health/route";
import ApiDocsPage from "../../app/api-docs/page";
import { apiDocsEnabled, openApiDocument } from "../openapi";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("openApiDocument", () => {
  it("is an OpenAPI 3.1 document describing the health endpoint", () => {
    expect(openApiDocument.openapi).toBe("3.1.0");
    expect(openApiDocument.info.title).toMatch(/hogsend cloud/i);
    expect(Object.keys(openApiDocument.paths)).toEqual(["/api/health"]);
    expect(
      openApiDocument.paths["/api/health"].get.responses["200"],
    ).toBeTruthy();
  });

  it("documents the exact response shape the health route returns", async () => {
    const schema =
      openApiDocument.paths["/api/health"].get.responses["200"].content[
        "application/json"
      ].schema;

    const body = (await (await healthGET()).json()) as Record<string, string>;

    // Documented and actual keys must be the same set — a doc that drifts from
    // the handler is worse than no doc.
    expect(Object.keys(schema.properties).sort()).toEqual(
      Object.keys(body).sort(),
    );
    expect([...schema.required].sort()).toEqual(Object.keys(body).sort());
    for (const [key, value] of Object.entries(body)) {
      expect(schema.properties[key]?.enum ?? []).toContain(value);
    }
  });
});

describe("apiDocsEnabled", () => {
  it("is off in production and on everywhere else", () => {
    expect(apiDocsEnabled("production")).toBe(false);
    expect(apiDocsEnabled("development")).toBe(true);
    expect(apiDocsEnabled("test")).toBe(true);
    expect(apiDocsEnabled(undefined)).toBe(true);
  });
});

describe("GET /api-docs", () => {
  it("renders in development", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(() => ApiDocsPage()).not.toThrow();
  });

  it("404s in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    let thrown: unknown;
    try {
      ApiDocsPage();
    } catch (error) {
      thrown = error;
    }
    // Next signals a 404 by throwing its fallback error; the digest is the
    // contract the router matches on.
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as { digest?: string }).digest).toContain("404");
  });
});
