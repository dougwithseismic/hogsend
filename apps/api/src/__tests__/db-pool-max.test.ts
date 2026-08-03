import { DEFAULT_POOL_MAX, MAX_POOL_MAX, parsePoolMax } from "@hogsend/db";
import { describe, expect, it } from "vitest";

/**
 * DATABASE_POOL_MAX — the tenant-stack pool cap (Hogsend Cloud PRD 06 §1).
 *
 * `postgres.js` silently ignores a `?max=` DSN param when options are passed,
 * so the pool size is an explicit env read. It is NOT introspectable off the
 * created client, so the contract is locked at the parse helper: the ONLY
 * decision `createDatabase` makes about pool size.
 *
 * Invariant: a bad value must degrade to the historical hardcoded 10, never
 * throw — a metering misconfiguration cannot be allowed to take a tenant's
 * API down at boot.
 */
describe("parsePoolMax", () => {
  it("defaults to 10 when unset or blank (behavior unchanged)", () => {
    expect(parsePoolMax(undefined)).toEqual({ max: 10, invalid: false });
    expect(parsePoolMax("")).toEqual({ max: 10, invalid: false });
    expect(parsePoolMax("   ")).toEqual({ max: 10, invalid: false });
    expect(DEFAULT_POOL_MAX).toBe(10);
  });

  it("accepts a positive integer within the cap", () => {
    expect(parsePoolMax("3")).toEqual({ max: 3, invalid: false });
    expect(parsePoolMax(" 25 ")).toEqual({ max: 25, invalid: false });
    expect(parsePoolMax(String(MAX_POOL_MAX))).toEqual({
      max: MAX_POOL_MAX,
      invalid: false,
    });
  });

  it("flags anything else invalid and falls back to the default", () => {
    for (const raw of [
      "0",
      "-1",
      "1.5",
      "abc",
      "10x",
      String(MAX_POOL_MAX + 1),
      "9999",
      "NaN",
      "Infinity",
    ]) {
      expect(parsePoolMax(raw)).toEqual({
        max: DEFAULT_POOL_MAX,
        invalid: true,
      });
    }
  });
});
