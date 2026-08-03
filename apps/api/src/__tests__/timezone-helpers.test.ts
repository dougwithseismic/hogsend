import {
  resolveTimezone,
  resolveTimezoneWithSource,
  setContactTimezone,
} from "@hogsend/engine";
import { describe, expect, it, vi } from "vitest";

describe("resolveTimezone precedence + validation", () => {
  it("prefers PostHog $timezone over geoip/contact/default", () => {
    const r = resolveTimezoneWithSource({
      posthogProperties: {
        $timezone: "Europe/London",
        $geoip_time_zone: "America/New_York",
      },
      contactTimezone: "Asia/Tokyo",
      defaultTimezone: "UTC",
    });
    expect(r).toEqual({
      timezone: "Europe/London",
      source: "posthog_timezone",
    });
  });

  it("falls through invalid DATA candidates (warn, not throw) to the next", () => {
    const warn = vi.fn();
    const r = resolveTimezoneWithSource({
      posthogProperties: { $timezone: "Not/AZone" },
      contactTimezone: "Asia/Tokyo",
      logger: { warn },
    });
    expect(r).toEqual({ timezone: "Asia/Tokyo", source: "contact_column" });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls back to UTC when nothing resolves", () => {
    expect(resolveTimezone({})).toBe("UTC");
  });

  it("THROWS on an invalid EXPLICIT timezone (author contract)", () => {
    expect(() =>
      resolveTimezoneWithSource({ explicit: "Amerca/New_York" }),
    ).toThrow(TypeError);
  });

  it("accepts a valid explicit timezone", () => {
    expect(resolveTimezone({ explicit: "America/New_York" })).toBe(
      "America/New_York",
    );
  });
});

describe("setContactTimezone", () => {
  /**
   * `returnedRows` is what the UPDATE returns; `resolvedRows` is what the
   * alias-aware key resolve finds first (PRD 07 T7 — `setContactTimezone` now
   * resolves the contact id, then writes by row id, so the stub needs a
   * `select` chain as well as the `update` one). They default to the same rows
   * because the ordinary case is "the key resolves and the write lands".
   */
  function makeDbStub(
    returnedRows: Array<{ id: string }>,
    resolvedRows: Array<{ id: string }> = returnedRows,
  ) {
    const returning = vi.fn().mockResolvedValue(returnedRows);
    const where = vi.fn().mockReturnValue({ returning });
    const set = vi.fn().mockReturnValue({ where });
    const update = vi.fn().mockReturnValue({ set });
    // One chainable stub covers both of `lookupContactIdByKey`'s probes (the
    // column one and the alias join); the first resolves, so the second is
    // never reached in these cases.
    const chain: Record<string, unknown> = {};
    const limit = vi.fn().mockResolvedValue(resolvedRows);
    for (const link of ["from", "where", "innerJoin", "orderBy"]) {
      chain[link] = vi.fn().mockReturnValue(chain);
    }
    chain.limit = limit;
    const select = vi.fn().mockReturnValue(chain);
    return {
      db: { select, update } as unknown as Parameters<
        typeof setContactTimezone
      >[0]["db"],
      update,
      set,
      where,
      returning,
      select,
    };
  }

  it("throws TypeError on an invalid zone — before touching the db", async () => {
    const { db, update } = makeDbStub([]);
    await expect(
      // a dynamically-built bad value (cast past the literal type)
      setContactTimezone({
        db,
        userId: "u1",
        timezone: "Mars/Olympus" as never,
      }),
    ).rejects.toThrow(TypeError);
    expect(update).not.toHaveBeenCalled();
  });

  it("updates contacts.timezone and reports updated:true", async () => {
    const { db, set } = makeDbStub([{ id: "c1" }]);
    const result = await setContactTimezone({
      db,
      userId: "u1",
      timezone: "Europe/Berlin",
    });
    expect(result).toEqual({ updated: true });
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "Europe/Berlin" }),
    );
  });

  it("reports updated:false when no contact row matched", async () => {
    const { db, update } = makeDbStub([]);
    const result = await setContactTimezone({
      db,
      userId: "missing",
      timezone: "Europe/Berlin",
    });
    expect(result).toEqual({ updated: false });
    // A key that owns no live contact resolves to nothing, so the write is
    // never attempted — the miss behaviour the flip had to preserve.
    expect(update).not.toHaveBeenCalled();
  });
});
