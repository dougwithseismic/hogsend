import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// flags-routes.test.ts). Drives `reconcileDefinedFlags` directly — the
// container's boot reconcile is skipped under NODE_ENV=test.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { flags } = await import("@hogsend/db");
const { and, eq, like } = await import("drizzle-orm");
const {
  createHogsendClient,
  defineFlag,
  evaluateFlagsForContact,
  reconcileDefinedFlags,
} = await import("@hogsend/engine");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `defx-${Date.now()}`;
function key(slug: string): string {
  return `${RUN}-${slug}`;
}

function rowFor(k: string) {
  return db
    .select()
    .from(flags)
    .where(eq(flags.key, k))
    .limit(1)
    .then((r) => r[0]);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await db.delete(flags).where(like(flags.key, `${RUN}-%`));
});

describe("reconcileDefinedFlags", () => {
  it("creates a new defined flag DISABLED, rollout 0, origin=code, targeting []", async () => {
    const k = key("new");
    const result = await reconcileDefinedFlags({
      client: container,
      flags: [
        defineFlag({
          key: k,
          name: "New flag",
          type: "boolean",
          description: "hello",
        }),
      ],
    });

    expect(result.created).toBe(1);
    const row = await rowFor(k);
    expect(row).toBeDefined();
    expect(row?.origin).toBe("code");
    expect(row?.enabled).toBe(false);
    expect(row?.rollout).toBe(0);
    expect(row?.targeting).toEqual([]);
    expect(row?.conditionSets).toEqual([]);
    expect(row?.defaultValue).toBe(false);
  });

  it("preserves operator STATE on re-run but syncs CONTRACT drift", async () => {
    const k = key("preserve");
    await reconcileDefinedFlags({
      client: container,
      flags: [defineFlag({ key: k, name: "V1", type: "boolean" })],
    });

    // Operator turns it on, sets a rollout + targeting via Studio/admin.
    const targeting = [
      {
        type: "property" as const,
        property: "plan",
        operator: "eq" as const,
        value: "pro",
      },
    ];
    await db
      .update(flags)
      .set({ enabled: true, rollout: 50, targeting })
      .where(eq(flags.key, k));

    // Contract drift: renamed + re-described.
    const result = await reconcileDefinedFlags({
      client: container,
      flags: [
        defineFlag({ key: k, name: "V2", type: "boolean", description: "now" }),
      ],
    });

    expect(result.updated).toBe(1);
    const row = await rowFor(k);
    // STATE preserved.
    expect(row?.enabled).toBe(true);
    expect(row?.rollout).toBe(50);
    expect(row?.targeting).toEqual(targeting);
    // CONTRACT synced.
    expect(row?.name).toBe("V2");
    expect(row?.description).toBe("now");
  });

  it("re-running an unchanged definition is a no-op (skipped, no rewrite)", async () => {
    const k = key("idempotent");
    const def = defineFlag({ key: k, name: "Same", type: "boolean" });
    await reconcileDefinedFlags({ client: container, flags: [def] });
    const result = await reconcileDefinedFlags({
      client: container,
      flags: [def],
    });
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    expect(result.skipped).toBe(1);
  });

  it("leaves a pre-existing non-code (native) flag with the same key untouched + warns", async () => {
    const k = key("native");
    await db.insert(flags).values({
      key: k,
      name: "Studio flag",
      type: "boolean",
      enabled: true,
      rollout: 100,
      origin: "native",
    });

    const warn = vi.spyOn(container.logger, "warn");
    const result = await reconcileDefinedFlags({
      client: container,
      flags: [defineFlag({ key: k, name: "Code wants this", type: "boolean" })],
    });

    expect(result.skipped).toBe(1);
    expect(result.created).toBe(0);
    expect(result.updated).toBe(0);
    const row = await rowFor(k);
    expect(row?.origin).toBe("native");
    expect(row?.name).toBe("Studio flag");
    expect(row?.enabled).toBe(true);
    // The warn must name the resolution, not just the collision — an
    // out-of-band seeded row for a code-defined key trips this on every boot.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("set origin = 'code'"),
      expect.objectContaining({ key: k, origin: "native" }),
    );
  });

  it("warns and skips duplicate keys in the defined array without throwing", async () => {
    const k = key("dup");
    const warn = vi.spyOn(container.logger, "warn");
    const result = await reconcileDefinedFlags({
      client: container,
      flags: [
        defineFlag({ key: k, name: "First", type: "boolean" }),
        defineFlag({ key: k, name: "Second", type: "boolean" }),
      ],
    });

    expect(result.created).toBe(1);
    expect(result.skipped).toBe(1);
    expect(warn).toHaveBeenCalled();
    const rows = await db.select().from(flags).where(eq(flags.key, k));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.name).toBe("First");
  });

  it("once enabled, a reconciled flag evaluates via evaluateFlagsForContact", async () => {
    const k = key("evaluates");
    await reconcileDefinedFlags({
      client: container,
      flags: [defineFlag({ key: k, name: "Eval", type: "boolean" })],
    });

    // Reconciled flags are born disabled → not in the evaluated map yet.
    const before = await evaluateFlagsForContact({
      db,
      contactKey: `${RUN}-contact`,
      mode: "server",
    });
    expect(k in before).toBe(false);

    // Operator enables it at full rollout (empty targeting = everyone).
    await db
      .update(flags)
      .set({ enabled: true, rollout: 100 })
      .where(and(eq(flags.key, k), eq(flags.origin, "code")));

    const after = await evaluateFlagsForContact({
      db,
      contactKey: `${RUN}-contact`,
      mode: "server",
    });
    expect(k in after).toBe(true);
    expect(after[k]).toBe(true);
  });
});
