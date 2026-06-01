import { hours, isFrequencyCapped, sendTrackedEmail } from "@hogsend/engine";
import type { EmailProvider } from "@hogsend/plugin-resend";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import { templates } from "../emails/index.js";

/**
 * A db double whose `select().from().where()` resolves a fixed count and whose
 * `insert().values().returning()` / `update().set().where()` are spies. The
 * suppression `select().from().where().limit()` path returns `[]` (no prefs).
 */
function makeDb(countValue: number) {
  // Captures the AND-condition list handed to the cap COUNT's `.where(...)` so
  // tests can assert the byCategory branch adds a category filter.
  const where = vi.fn((..._args: unknown[]) => {
    const promise = Promise.resolve([{ n: countValue }]);
    // suppression path adds `.limit()`; cap path awaits directly.
    return Object.assign(promise, {
      limit: () => Promise.resolve([]),
    });
  });
  const selectFrom = { where };
  const insertReturning = vi.fn().mockResolvedValue([{ id: "send-1" }]);
  const insert = vi.fn().mockReturnValue({
    values: () => ({ returning: insertReturning }),
  });
  const updateWhere = vi.fn().mockResolvedValue(undefined);
  const update = vi.fn().mockReturnValue({
    set: () => ({ where: updateWhere }),
  });
  const db = {
    select: () => ({ from: () => selectFrom }),
    insert,
    update,
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal test double
  return { db: db as any, insert, insertReturning, where };
}

function makeProvider(): EmailProvider & { send: ReturnType<typeof vi.fn> } {
  const send = vi.fn().mockResolvedValue({ id: "resend-1" });
  // biome-ignore lint/suspicious/noExplicitAny: only `send` is exercised
  return { send } as any;
}

describe("isFrequencyCapped", () => {
  it("returns false when no config (opt-in)", async () => {
    const { db } = makeDb(99);
    expect(
      await isFrequencyCapped({ db, to: "a@b.com", config: undefined }),
    ).toBe(false);
  });

  it("returns false for an exempt category (default transactional)", async () => {
    const { db } = makeDb(99);
    expect(
      await isFrequencyCapped({
        db,
        to: "a@b.com",
        category: "transactional",
        config: { count: 1, window: hours(24) },
      }),
    ).toBe(false);
  });

  it("returns true when count >= cap", async () => {
    const { db } = makeDb(3);
    expect(
      await isFrequencyCapped({
        db,
        to: "a@b.com",
        config: { count: 3, window: hours(24) },
      }),
    ).toBe(true);
  });

  it("returns false when count < cap", async () => {
    const { db } = makeDb(2);
    expect(
      await isFrequencyCapped({
        db,
        to: "a@b.com",
        config: { count: 3, window: hours(24) },
      }),
    ).toBe(false);
  });

  // Render the AND-condition that `isFrequencyCapped` hands to `.where(...)`
  // into parameterized SQL text so we can assert which columns participate.
  function whereSql(andArg: unknown): string {
    // biome-ignore lint/suspicious/noExplicitAny: drizzle SQL → query text
    return new PgDialect().sqlToQuery(andArg as any).sql;
  }

  it("byCategory override uses its own count and filters by category", async () => {
    // Global rule (no override hit): filters by recipient + recency + status,
    // NOT by category.
    const globalDb = makeDb(0);
    await isFrequencyCapped({
      db: globalDb.db,
      to: "a@b.com",
      config: { count: 1, window: hours(24) },
    });
    expect(whereSql(globalDb.where.mock.calls[0]?.[0])).not.toContain(
      '"category"',
    );

    // Override branch (category present + byCategory entry): the COUNT is
    // additionally filtered by category = <category>.
    const overrideDb = makeDb(0);
    await isFrequencyCapped({
      db: overrideDb.db,
      to: "a@b.com",
      category: "marketing",
      config: {
        count: 1,
        window: hours(24),
        byCategory: { marketing: { count: 5, window: hours(24) } },
      },
    });
    expect(whereSql(overrideDb.where.mock.calls[0]?.[0])).toContain(
      '"category"',
    );
  });

  it("byCategory override uses its own count (3 prior < 5 ⇒ not capped)", async () => {
    // Global cap is 1, but the marketing override allows 5. With 3 prior sends
    // the global rule would cap; the override must NOT cap (3 < 5).
    const { db } = makeDb(3);
    const capped = await isFrequencyCapped({
      db,
      to: "a@b.com",
      category: "marketing",
      config: {
        count: 1,
        window: hours(24),
        byCategory: { marketing: { count: 5, window: hours(24) } },
      },
    });
    expect(capped).toBe(false);
  });

  it("byCategory override DOES cap once its own count is reached", async () => {
    const { db } = makeDb(5);
    const capped = await isFrequencyCapped({
      db,
      to: "a@b.com",
      category: "marketing",
      config: {
        count: 1,
        window: hours(24),
        byCategory: { marketing: { count: 5, window: hours(24) } },
      },
    });
    expect(capped).toBe(true);
  });
});

describe("sendTrackedEmail frequency cap", () => {
  const baseOptions = {
    templateKey: "welcome" as const,
    props: { name: "Doug" },
    from: "noreply@hogsend.com",
    to: "doug@example.com",
  };

  it("skips the send when capped: no provider call, no row", async () => {
    const { db, insert } = makeDb(5);
    const provider = makeProvider();

    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      frequencyCap: { count: 1, window: hours(24) },
      options: baseOptions,
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("frequency_capped");
    expect(result.emailSendId).toBe("");
    expect(provider.send).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("sends normally when under the cap", async () => {
    const { db, insert } = makeDb(0);
    const provider = makeProvider();

    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      frequencyCap: { count: 3, window: hours(24) },
      options: baseOptions,
    });

    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalled();
  });

  it("exempt category always sends even over the cap", async () => {
    // Count is 99, cap is 1 — but the default-exempt "transactional" category
    // must bypass the cap entirely and dispatch.
    const { db } = makeDb(99);
    const provider = makeProvider();

    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      frequencyCap: { count: 1, window: hours(24) },
      options: { ...baseOptions, category: "transactional" },
    });

    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });

  it("per-category override caps the send (no provider call, no row)", async () => {
    // 5 prior marketing sends; the marketing override caps at 2 ⇒ skip.
    const { db, insert } = makeDb(5);
    const provider = makeProvider();

    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      frequencyCap: {
        count: 99,
        window: hours(24),
        byCategory: { marketing: { count: 2, window: hours(24) } },
      },
      options: { ...baseOptions, category: "marketing" },
    });

    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("frequency_capped");
    expect(provider.send).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("skipPreferenceCheck bypasses the cap (system send)", async () => {
    const { db } = makeDb(99);
    const provider = makeProvider();

    const result = await sendTrackedEmail({
      db,
      provider,
      registry: templates,
      frequencyCap: { count: 1, window: hours(24) },
      options: { ...baseOptions, skipPreferenceCheck: true },
    });

    expect(result.status).toBe("sent");
    expect(provider.send).toHaveBeenCalledTimes(1);
  });
});
