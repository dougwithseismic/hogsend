/**
 * `mapHttpError` — status → structured `code` mapping. A non-HttpError is
 * re-thrown (a real bug, never an expected outcome).
 */
import { describe, expect, it } from "vitest";
import { mapHttpError } from "../lib/result.js";
import { httpError } from "./helpers.js";

describe("mapHttpError", () => {
  it("maps each status to its stable code", () => {
    expect(mapHttpError(httpError(0, undefined)).code).toBe("unreachable");
    expect(mapHttpError(httpError(401, { error: "x" })).code).toBe(
      "unauthorized",
    );
    expect(mapHttpError(httpError(403, { error: "x" })).code).toBe("forbidden");
    expect(mapHttpError(httpError(404, { error: "x" })).code).toBe("not_found");
    expect(mapHttpError(httpError(500, { error: "x" })).code).toBe("error");
  });

  it("adds a full-admin-scope hint to the 403 message", () => {
    const result = mapHttpError(
      httpError(403, { error: "Forbidden: insufficient scope" }),
    );
    expect(result.error).toContain("full-admin");
  });

  it("maps 422 to invalid_graph with the issues passed through", () => {
    const issues = [{ path: [], code: "c", message: "m" }];
    const result = mapHttpError(httpError(422, { error: "bad", issues }));
    expect(result.code).toBe("invalid_graph");
    expect(result.issues).toEqual(issues);
  });

  it("defaults 409 to conflict when the body has no code", () => {
    const result = mapHttpError(httpError(409, { error: "already exists" }));
    expect(result.code).toBe("conflict");
    expect(result.error).toBe("already exists");
  });

  it("passes a 409 body's explicit code through when present", () => {
    const result = mapHttpError(
      httpError(409, { code: "in_flight", error: "busy" }),
    );
    expect(result.code).toBe("in_flight");
  });

  it("re-throws a non-HttpError (unexpected bug)", () => {
    expect(() => mapHttpError(new Error("boom"))).toThrow("boom");
  });
});
