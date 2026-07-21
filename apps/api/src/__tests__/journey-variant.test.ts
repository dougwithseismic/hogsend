/**
 * `ctx.variant` — unit suite (impact experiments, Decision B).
 *
 * Part A (this block): the PURE assignment library (lib/variant.ts) — golden
 * hash values (the FROZEN `variant:<journeyId>:<key>:<userId>` compatibility
 * contract), deterministic distribution, the bucket-9999 edge, statistical
 * independence from holdout assignment, and the key/arms validation split.
 * Later tasks append the __variants__ namespace and ctx-level blocks.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, describe, expect, it, vi } from "vitest";

const {
  isHeldOut,
  pickVariant,
  validateVariantArms,
  validateVariantKey,
  variantBucket,
} = await import("@hogsend/engine/testing");

const { journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  recordOnce,
  stripRecordNamespaces,
} = await import("@hogsend/engine");
type RecordDb = Parameters<typeof recordOnce>[0]["db"];

// Mock-free container: these blocks only touch Postgres via recordOnce.
const mockHatchet = {
  durableTask: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn().mockResolvedValue(undefined) },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];
const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `var-${Date.now()}`;
let seeded = 0;
async function freshState(context?: Record<string, unknown>): Promise<string> {
  seeded += 1;
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: `${RUN}-${seeded}`,
      userEmail: `${RUN}-${seeded}@example.com`,
      journeyId: `${RUN}-journey`,
      currentNodeId: "start",
      status: "active",
      ...(context ? { context } : {}),
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

async function readContext(stateId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.id, stateId));
  return (row?.context ?? {}) as Record<string, unknown>;
}

describe("variantBucket — frozen hash contract (golden values)", () => {
  it("matches the frozen golden buckets for 3 fixed inputs", () => {
    // Input string is `variant:<journeyId>:<key>:<userId>` — sha256, first 4
    // bytes BE, mod 10000. Changing ANY of these numbers means the hash
    // input changed and every live experiment re-buckets mid-flight.
    expect(
      variantBucket({
        journeyId: "activation-welcome",
        key: "welcome-subject",
        userId: "user-1",
      }),
    ).toBe(8045);
    expect(
      variantBucket({
        journeyId: "activation-welcome",
        key: "welcome-subject",
        userId: "user-2",
      }),
    ).toBe(7592);
    expect(
      variantBucket({ journeyId: "j2", key: "k2", userId: "user-1" }),
    ).toBe(4296);
  });

  it("maps golden buckets to arms via pickVariant (equal split thresholds)", () => {
    // bucket 8045 >= 5000 → second of two arms.
    expect(
      pickVariant({
        journeyId: "activation-welcome",
        key: "welcome-subject",
        userId: "user-1",
        arms: ["setup", "outcome"],
      }),
    ).toBe("outcome");
    // bucket 4296 < 5000 → first of two arms.
    expect(
      pickVariant({
        journeyId: "j2",
        key: "k2",
        userId: "user-1",
        arms: ["setup", "outcome"],
      }),
    ).toBe("setup");
    // 3 arms: thresholds 3333 / 6667 / 10000; 3333 <= 4296 < 6667 → "b".
    expect(
      pickVariant({
        journeyId: "j2",
        key: "k2",
        userId: "user-1",
        arms: ["a", "b", "c"],
      }),
    ).toBe("b");
  });
});

describe("pickVariant — distribution and edges (deterministic, no flake)", () => {
  const ids = Array.from({ length: 10000 }, (_, i) => `u${i}`);
  const opts = (userId: string) => ({
    journeyId: "dist-journey",
    key: "dist-key",
    userId,
  });

  it("splits 2 arms 45-55% over 10k synthetic ids", () => {
    const a = ids.filter(
      (id) => pickVariant({ ...opts(id), arms: ["a", "b"] }) === "a",
    ).length;
    // Deterministic: exactly 5069 with this journeyId/key/id-set.
    expect(a).toBeGreaterThanOrEqual(4500);
    expect(a).toBeLessThanOrEqual(5500);
  });

  it("splits 3 arms 28-39% each over 10k synthetic ids", () => {
    const counts = { a: 0, b: 0, c: 0 };
    for (const id of ids) {
      const arm = pickVariant({ ...opts(id), arms: ["a", "b", "c"] });
      counts[arm as "a" | "b" | "c"] += 1;
    }
    // Deterministic: a 3370 / b 3338 / c 3292 with this id-set.
    for (const arm of ["a", "b", "c"] as const) {
      expect(counts[arm]).toBeGreaterThanOrEqual(2800);
      expect(counts[arm]).toBeLessThanOrEqual(3900);
    }
  });

  it("assigns bucket 9999 to the LAST arm (rounding can never strand it)", () => {
    // u10919 is a precomputed id whose bucket is exactly 9999 for
    // ("dist-journey", "dist-key").
    expect(variantBucket(opts("u10919"))).toBe(9999);
    expect(pickVariant({ ...opts("u10919"), arms: ["a", "b", "c"] })).toBe("c");
    expect(pickVariant({ ...opts("u10919"), arms: ["a", "b"] })).toBe("b");
  });

  it("is statistically independent of holdout assignment (50% holdout)", () => {
    // The `variant:` prefix + key segment make the variant hash family
    // DISJOINT from holdoutBucket's `<salt>:<journeyId>:<userId>` — the
    // variant split must stay ~50/50 INSIDE each holdout cohort.
    const held: string[] = [];
    const free: string[] = [];
    for (const id of ids) {
      (isHeldOut({ userId: id, journeyId: "dist-journey", percent: 50 })
        ? held
        : free
      ).push(id);
    }
    // Deterministic with this id-set: held 5011 / free 4989.
    expect(held.length).toBeGreaterThan(4500);
    expect(free.length).toBeGreaterThan(4500);
    for (const cohort of [held, free]) {
      const a = cohort.filter(
        (id) => pickVariant({ ...opts(id), arms: ["a", "b"] }) === "a",
      ).length;
      const pct = (a / cohort.length) * 100;
      expect(pct).toBeGreaterThanOrEqual(45);
      expect(pct).toBeLessThanOrEqual(55);
    }
  });
});

describe("validateVariantKey — syntax gate (RangeError)", () => {
  it.each([
    ["colon", "a:b"],
    ["bare colon", ":"],
    ["space", "a b"],
    ["empty", ""],
    ["65 chars", "a".repeat(65)],
    ["leading dash", "-lead"],
    ["leading dot", ".lead"],
  ])("rejects %s", (_label, key) => {
    expect(() => validateVariantKey(key)).toThrow(RangeError);
  });

  it.each([
    ["kebab", "welcome-subject"],
    ["single char", "A"],
    ["mixed charset", "k.v_1-x"],
    ["64 chars", "a".repeat(64)],
  ])("accepts %s", (_label, key) => {
    expect(() => validateVariantKey(key)).not.toThrow();
  });
});

describe("validateVariantArms — compute-path gate (RangeError)", () => {
  it("rejects zero arms (JS callers; TS blocks via the tuple type)", () => {
    expect(() => validateVariantArms([])).toThrow(RangeError);
  });

  it("rejects an empty-string arm", () => {
    expect(() => validateVariantArms(["a", ""])).toThrow(RangeError);
  });

  it("rejects a non-string arm (JS caller)", () => {
    expect(() => validateVariantArms(["a", 5 as unknown as string])).toThrow(
      RangeError,
    );
  });

  it("rejects duplicate arms", () => {
    expect(() => validateVariantArms(["a", "b", "a"])).toThrow(RangeError);
  });

  it("accepts distinct non-empty arms", () => {
    expect(() => validateVariantArms(["a", "b", "c"])).not.toThrow();
  });
});

afterAll(async () => {
  for (let i = 1; i <= seeded; i += 1) {
    await db
      .delete(journeyStates)
      .where(eq(journeyStates.userId, `${RUN}-${i}`));
  }
});

describe("__variants__ — reserved record-once namespace", () => {
  it("isolates namespaces — same key in __once__ and __variants__ never clobber", async () => {
    const stateId = await freshState();

    const onceVal = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__once__",
      key: "shared",
      compute: async () => "once-value",
    });
    const variantVal = await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__variants__",
      key: "shared",
      compute: async () => "outcome",
    });

    expect(onceVal).toBe("once-value");
    expect(variantVal).toBe("outcome");

    const bag = await readContext(stateId);
    expect((bag.__once__ as Record<string, unknown>).shared).toBe("once-value");
    expect((bag.__variants__ as Record<string, unknown>).shared).toBe(
      "outcome",
    );
  });

  it("stores the bare arm string under context.__variants__.<key>", async () => {
    const stateId = await freshState();
    await recordOnce({
      db: db as RecordDb,
      stateId,
      namespace: "__variants__",
      key: "welcome-subject",
      compute: () => "setup",
    });
    const bag = await readContext(stateId);
    expect(bag.__variants__).toEqual({ "welcome-subject": "setup" });
  });
});

describe("stripRecordNamespaces — the seeding injection filter", () => {
  it("removes all five reserved namespace keys and keeps everything else", () => {
    expect(
      stripRecordNamespaces({
        plan: "pro",
        score: 7,
        __once__: "evil",
        __digest__: "evil",
        __throttle__: "evil",
        __variants__: "evil",
        __groupKeys__: "evil",
      }),
    ).toEqual({ plan: "pro", score: 7 });
  });

  it("is an identity on clean bags and never mutates its input", () => {
    const input = { plan: "pro" };
    const out = stripRecordNamespaces(input);
    expect(out).toEqual({ plan: "pro" });
    expect(input).toEqual({ plan: "pro" });
  });
});

/** Build a real journey context wired to the container db + a spy logger.
 * `journeyId` is required by ctx.variant (pass it in test configs — the
 * engine always sets it in executeJourneyRun). */
function makeVariantCtx(opts: {
  stateId: string;
  userId: string;
  journeyId?: string;
  db?: unknown;
}) {
  const warn = vi.fn();
  const sleepFor = vi.fn(async () => ({}));
  const waitFor = vi.fn(async () => ({}));
  const ctx = createJourneyContext({
    db: (opts.db ?? db) as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: sleepFor as unknown as (d: unknown) => Promise<unknown>,
      waitFor: waitFor as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: vi.fn(), warn, error: vi.fn() } as any,
    stateId: opts.stateId,
    userId: opts.userId,
    userEmail: `${opts.userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
    ...(opts.journeyId ? { journeyId: opts.journeyId } : {}),
  });
  return { ctx, warn, sleepFor, waitFor };
}

describe("ctx.variant — engine context implementation", () => {
  it("throws when the context has no journeyId (before any db read)", async () => {
    const accesses: string[] = [];
    const spyDb = new Proxy(
      {},
      {
        get(_t, prop) {
          accesses.push(String(prop));
          throw new Error(`db touched: ${String(prop)}`);
        },
      },
    );
    const { ctx } = makeVariantCtx({
      stateId: "unused",
      userId: "u",
      db: spyDb,
    });
    await expect(ctx.variant("k", ["a", "b"])).rejects.toThrow(/journey id/);
    expect(accesses).toEqual([]);
  });

  it("key validation precedes durability — malformed key, spy db untouched", async () => {
    const accesses: string[] = [];
    const spyDb = new Proxy(
      {},
      {
        get(_t, prop) {
          accesses.push(String(prop));
          throw new Error(`db touched: ${String(prop)}`);
        },
      },
    );
    const { ctx } = makeVariantCtx({
      stateId: "unused",
      userId: "u",
      journeyId: "j",
      db: spyDb,
    });
    await expect(ctx.variant("bad key", ["a", "b"])).rejects.toThrow(
      RangeError,
    );
    await expect(ctx.variant("a:b", ["a", "b"])).rejects.toThrow(RangeError);
    expect(accesses).toEqual([]);
  });

  it("derives, records, and persists the deterministic arm; issues zero durable calls", async () => {
    const stateId = await freshState();
    const userId = `${RUN}-ctx-derive`;
    const journeyId = `${RUN}-jd`;
    const { ctx, sleepFor, waitFor } = makeVariantCtx({
      stateId,
      userId,
      journeyId,
    });

    const arm = await ctx.variant("welcome-subject", ["setup", "outcome"]);
    expect(arm).toBe(
      pickVariant({
        journeyId,
        key: "welcome-subject",
        userId,
        arms: ["setup", "outcome"],
      }),
    );

    const bag = await readContext(stateId);
    expect(bag.__variants__).toEqual({ "welcome-subject": arm });

    // Journal invisibility: ctx.variant is positionally invisible — NO
    // durable Hatchet calls, like ctx.throttle.
    expect(sleepFor).not.toHaveBeenCalled();
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("arms validation fires ONLY via compute — a recorded key skips it", async () => {
    const stateId = await freshState({
      __variants__: { pick: "a" },
    });
    const { ctx } = makeVariantCtx({
      stateId,
      userId: `${RUN}-ctx-armskip`,
      journeyId: `${RUN}-ja`,
    });
    // Duplicate arms are malformed, but the recorded fast path never
    // validates them — a deploy shipping bad arms must not crash an
    // in-flight enrollment.
    await expect(ctx.variant("pick", ["a", "a"])).resolves.toBe("a");
  });

  it("arms validation throws on a FRESH assignment (compute path)", async () => {
    const stateId = await freshState();
    const { ctx } = makeVariantCtx({
      stateId,
      userId: `${RUN}-ctx-armfresh`,
      journeyId: `${RUN}-jf`,
    });
    await expect(ctx.variant("pick", ["a", "a"])).rejects.toThrow(RangeError);
    await expect(ctx.variant("empty", ["" as string, "b"])).rejects.toThrow(
      RangeError,
    );
  });

  it("recorded arm wins VERBATIM across an arms change; warns once per process per journeyId:key", async () => {
    const journeyId = `${RUN}-jwarn`;
    const stateId = await freshState({
      __variants__: { "welcome-subject": "legacy-arm" },
    });
    const { ctx, warn } = makeVariantCtx({
      stateId,
      userId: `${RUN}-ctx-legacy`,
      journeyId,
    });

    const first = await ctx.variant("welcome-subject", ["setup", "outcome"]);
    expect(first).toBe("legacy-arm");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(journeyId);
    expect(String(warn.mock.calls[0]?.[0])).toContain("welcome-subject");
    expect(String(warn.mock.calls[0]?.[0])).toContain("legacy-arm");

    // Same ctx, same key: no re-warn.
    const second = await ctx.variant("welcome-subject", ["setup", "outcome"]);
    expect(second).toBe("legacy-arm");
    expect(warn).toHaveBeenCalledTimes(1);

    // A NEW context (fresh logger) for the same journeyId:key — the
    // warn-once set is process-level, so still no new warning.
    const fresh = makeVariantCtx({
      stateId,
      userId: `${RUN}-ctx-legacy`,
      journeyId,
    });
    await expect(
      fresh.ctx.variant("welcome-subject", ["setup", "outcome"]),
    ).resolves.toBe("legacy-arm");
    expect(fresh.warn).not.toHaveBeenCalled();
  });

  it("never returns a non-string fast-path value: recomputes deterministically and repairs the slot", async () => {
    const journeyId = `${RUN}-jpoison`;
    const userId = `${RUN}-ctx-poison`;
    const stateId = await freshState({
      __variants__: { poisoned: { evil: true }, sibling: "kept" },
    });
    const { ctx, warn } = makeVariantCtx({ stateId, userId, journeyId });

    const arm = await ctx.variant("poisoned", ["a", "b"]);
    const expected = pickVariant({
      journeyId,
      key: "poisoned",
      userId,
      arms: ["a", "b"],
    });
    expect(arm).toBe(expected);
    expect(warn).toHaveBeenCalledTimes(1);

    // The guarded jsonb repair replaced the injected object with the
    // derived arm STRING (keeps the 2b readout dimension clean) and
    // preserved the sibling key.
    const bag = await readContext(stateId);
    expect(bag.__variants__).toEqual({ poisoned: expected, sibling: "kept" });
  });

  it("same-key reuse + Promise.all race commit a single arm", async () => {
    const stateId = await freshState();
    const userId = `${RUN}-ctx-race`;
    const journeyId = `${RUN}-jr`;
    const { ctx } = makeVariantCtx({ stateId, userId, journeyId });

    const [x, y] = await Promise.all([
      ctx.variant("race", ["a", "b"]),
      ctx.variant("race", ["a", "b"]),
    ]);
    const z = await ctx.variant("race", ["a", "b"]);
    expect(x).toBe(y);
    expect(z).toBe(x);

    const bag = await readContext(stateId);
    expect(Object.keys(bag.__variants__ as Record<string, unknown>)).toEqual([
      "race",
    ]);
  });
});
