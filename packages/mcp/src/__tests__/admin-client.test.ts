/**
 * `buildUrl` — joins a path onto the base WITHOUT letting an absolute path drop
 * a base subpath prefix (the reverse-proxy-under-a-subpath case).
 */
import { describe, expect, it } from "vitest";
import { buildUrl } from "../lib/admin-client.js";

describe("buildUrl", () => {
  it("preserves a base subpath prefix", () => {
    expect(buildUrl("https://proxy.example.com/hogsend", "/v1/admin/x")).toBe(
      "https://proxy.example.com/hogsend/v1/admin/x",
    );
  });

  it("preserves a base subpath prefix when the base has a trailing slash", () => {
    expect(buildUrl("https://proxy.example.com/hogsend/", "/v1/admin/x")).toBe(
      "https://proxy.example.com/hogsend/v1/admin/x",
    );
  });

  it("leaves a root base unchanged (no subpath)", () => {
    expect(buildUrl("https://api.example.com", "/v1/admin/x")).toBe(
      "https://api.example.com/v1/admin/x",
    );
    expect(buildUrl("https://api.example.com/", "/v1/admin/x")).toBe(
      "https://api.example.com/v1/admin/x",
    );
  });

  it("handles a path with no leading slash", () => {
    expect(buildUrl("https://api.example.com/hogsend", "v1/x")).toBe(
      "https://api.example.com/hogsend/v1/x",
    );
  });

  it("appends query params and drops undefined values", () => {
    expect(
      buildUrl("https://api.example.com", "/v1/x", {
        limit: 10,
        search: undefined,
      }),
    ).toBe("https://api.example.com/v1/x?limit=10");
  });
});
