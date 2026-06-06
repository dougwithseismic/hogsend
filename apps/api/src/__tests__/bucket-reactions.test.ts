import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

// DB-touching test: point at the real docker TimescaleDB (mirrors
// buckets.test.ts), overriding the vitest.config placeholder DATABASE_URL. The
// reaction filter tests (6/7/8) drive a reaction's durable `task.fn` against the
// real DB (the enrollment guards write a `journeyStates` row before `run`).
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Dual mock: the reaction tasks are BUILT inside @hogsend/engine (which uses the
// ENGINE's own `lib/hatchet.js`), so we mock BOTH that absolute source path AND
// the API's `../lib/hatchet.js`. The mock PRESERVES the `config` passed to
// `durableTask()` (via `...config` spread) so a reaction's `task.onEvents` /
// `task.fn` survive the mock and the test can assert on them + invoke the body.
// `vi.hoisted` shares the spy + factory across both mocks.
const { pushSpy, hatchetMock } = vi.hoisted(() => {
  const push = vi.fn();
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
        runAndWait: vi.fn(),
      })),
      task: vi.fn((config: Record<string, unknown>) => ({
        ...config,
        run: vi.fn(),
        runNoWait: vi.fn(),
      })),
      events: { push },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { pushSpy: push, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, journeyStates } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const {
  collectBucketReactionJourneys,
  createHogsendClient,
  days,
  defineBucket,
  defineJourney,
  durationToMs,
  hours,
  resetBucketRegistry,
  selectBucketReactionTasks,
} = await import("@hogsend/engine");

const container = createHogsendClient();
const { db } = container;

const RUN = `rxn-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const uid = (label: string) => `${RUN}-${label}`;

// The flagship "went-dormant" bucket fixture used by the desugar tests, mirroring
// apps/api/src/buckets/went-dormant.ts. `as const` id literal so `entered`/`left`
// are literal-typed (Test 30). Each `it` builds its own bucket so reactions never
// leak across tests; this one stays declaration-free of reactions.
const WENT_DORMANT_ID = `${RUN}-went-dormant`;
function makeBucket(id: string = WENT_DORMANT_ID) {
  return defineBucket({
    meta: {
      id,
      name: "Went dormant",
      enabled: true,
      timeBased: true,
      criteria: (b) =>
        b.all(
          b.event(`${RUN}:app.active`).exists(),
          b.event(`${RUN}:app.active`).within(days(7)).notExists(),
        ),
    },
  });
}

/** Upsert a contact so the reaction enrollment guards + run see real state. */
async function seedContact(userId: string): Promise<void> {
  await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@example.com`,
      properties: {},
    })
    .onConflictDoNothing();
}

/**
 * A minimal Hatchet durable-context stub for invoking a reaction `task.fn`
 * directly. Provides `workflowRunId()` (read at enrollment) + `sleepFor`/`waitFor`
 * (read lazily by the journey context, never reached by the filter tests).
 */
function makeHatchetCtx() {
  return {
    workflowRunId: () => uid(`run-${Math.floor(Math.random() * 1e9)}`),
    sleepFor: vi.fn(),
    waitFor: vi.fn(),
    // biome-ignore lint/suspicious/noExplicitAny: minimal durable-context stub
  } as any;
}

/**
 * Run a reaction's durable `task.fn` end-to-end against the real DB (the mock
 * preserved the body). The enrollment guard chain (enabled → admin override →
 * trigger.where → entryLimit → email-prefs → active-state dedup → journeyStates
 * insert → createJourneyContext) runs before `run`, so a contact must be seeded.
 * The `properties` map carries the reaction discriminators (`entryCount`/`reason`/
 * `dwellCount`) the desugared `run` reads off `user.properties`.
 */
async function runReaction(
  task: { fn: (input: unknown, ctx: unknown) => Promise<unknown> },
  opts: { userId: string; properties?: Record<string, unknown> },
): Promise<unknown> {
  return task.fn(
    {
      userId: opts.userId,
      userEmail: `${opts.userId}@example.com`,
      properties: opts.properties ?? {},
    },
    makeHatchetCtx(),
  );
}

beforeEach(() => {
  pushSpy.mockClear();
});

afterEach(async () => {
  resetBucketRegistry();
  // Targeted cleanup — the reaction-filter tests write journeyStates rows for
  // RUN-namespaced users (everything is RUN-prefixed, so this is exact).
  await db
    .delete(journeyStates)
    .where(like(journeyStates.userId, `${RUN}-%`))
    .catch(() => {});
});

// ===========================================================================
// 1 — typed transition refs (literal value + deprecated-helper parity)
// ===========================================================================

describe("typed transition refs (Test 1)", () => {
  it("entered/left are the literal bucket transition event names", () => {
    const wentDormant = defineBucket({
      meta: { id: "went-dormant", name: "Went dormant", enabled: true },
    });
    expect(wentDormant.entered).toBe("bucket:entered:went-dormant");
    expect(wentDormant.left).toBe("bucket:left:went-dormant");
  });

  it("value-equals the deprecated bucketLeft helper (byte-identical)", () => {
    const wentDormant = defineBucket({
      meta: { id: "went-dormant", name: "Went dormant", enabled: true },
    });
    // The deprecated helper is `bucket:left:${id}` — the same string the typed
    // ref derives, so the migration cannot change the routed event name.
    const bucketLeft = <T extends string>(id: T) =>
      `bucket:left:${id}` as const;
    expect(wentDormant.left).toBe(bucketLeft("went-dormant"));
  });
});

// ===========================================================================
// 2 — .on() chaining + reactions array growth
// ===========================================================================

describe(".on() chaining (Test 2)", () => {
  it("returns the bucket for chaining and pushes one reaction per call", () => {
    const bucket = makeBucket(uid("chain"));
    expect(bucket.reactions).toHaveLength(0);

    const returned = bucket.on("enter", async () => {});
    expect(returned).toBe(bucket);
    expect(bucket.reactions).toHaveLength(1);

    bucket
      .on("leave", async () => {})
      .on("dwell", { after: days(7) }, async () => {});
    expect(bucket.reactions).toHaveLength(3);
  });
});

// ===========================================================================
// 3 — enter desugar shape
// ===========================================================================

describe("enter desugar (Test 3)", () => {
  it("produces a DefinedJourney with the canonical enter meta + task binding", () => {
    const bucket = makeBucket(uid("enter-desugar"));
    bucket.on("enter", async () => {});
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    expect(reaction.meta.id).toBe(`bucket-${bucket.meta.id}-on-enter`);
    expect(reaction.meta.trigger.event).toBe(bucket.entered);
    expect(reaction.meta.entryLimit).toBe("unlimited");
    expect(reaction.meta.suppress).toEqual({ seconds: 0 });
    expect(reaction.meta.sourceBucketId).toBe(bucket.meta.id);
    expect(reaction.meta.reactionKind).toBe("enter");
    // The mock preserved `onEvents` — Hatchet routes the reaction by it.
    expect(
      (reaction.task as unknown as { onEvents: string[] }).onEvents,
    ).toEqual([bucket.entered]);
  });
});

// ===========================================================================
// 4 — leave desugar shape
// ===========================================================================

describe("leave desugar (Test 4)", () => {
  it("binds to bucket.left with the -on-leave id", () => {
    const bucket = makeBucket(uid("leave-desugar"));
    bucket.on("leave", async () => {});
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    expect(reaction.meta.id).toBe(`bucket-${bucket.meta.id}-on-leave`);
    expect(reaction.meta.trigger.event).toBe(bucket.left);
    expect(reaction.meta.reactionKind).toBe("leave");
  });
});

// ===========================================================================
// 5 — dwell desugar id/event stability + two schedules coexist
// ===========================================================================

describe("dwell desugar (Test 5)", () => {
  it("derives a stable, schedule-labelled id + event from the duration", () => {
    const bucket = makeBucket(uid("dwell-desugar"));
    bucket.on("dwell", { after: days(7) }, async () => {});
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const ms = durationToMs(days(7)); // 604800000
    expect(ms).toBe(604_800_000);
    expect(reaction.meta.id).toBe(
      `bucket-${bucket.meta.id}-on-dwell-after-${ms}`,
    );
    expect(reaction.meta.trigger.event).toBe(
      `bucket:dwell:${bucket.meta.id}:after-${ms}`,
    );
    expect(reaction.meta.reactionKind).toBe("dwell");
    expect(reaction.meta.dwellSchedule).toEqual({
      label: `after-${ms}`,
      after: ms,
    });
  });

  it("an after + an every dwell get distinct ids and events", () => {
    const bucket = makeBucket(uid("dwell-two"));
    bucket
      .on("dwell", { after: days(7) }, async () => {})
      .on("dwell", { every: hours(1) }, async () => {});

    const [a, b] = bucket.reactions;
    if (!a || !b) throw new Error("expected two reactions");
    const afterMs = durationToMs(days(7));
    const everyMs = durationToMs(hours(1));

    expect(a.meta.id).toBe(
      `bucket-${bucket.meta.id}-on-dwell-after-${afterMs}`,
    );
    expect(b.meta.id).toBe(
      `bucket-${bucket.meta.id}-on-dwell-every-${everyMs}`,
    );
    expect(a.meta.trigger.event).not.toBe(b.meta.trigger.event);
    expect(b.meta.dwellSchedule).toEqual({
      label: `every-${everyMs}`,
      every: everyMs,
    });
  });
});

// ===========================================================================
// 6 — enter firstEntryOnly filter (runs inside run, AFTER enrollment)
// ===========================================================================

describe("enter firstEntryOnly filter (Test 6)", () => {
  it("does NOT call the handler on a re-entry when firstEntryOnly is set", async () => {
    const handler = vi.fn(async () => {});
    const bucket = makeBucket(uid("first-only-skip"));
    bucket.on("enter", { firstEntryOnly: true }, handler);
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("first-only-skip-user");
    await seedContact(userId);

    // entryCount = 2 → not the first entry → filtered out.
    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { entryCount: 2 } },
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls the handler on the first entry with ctx.isFirstEntry true", async () => {
    let seenIsFirstEntry: boolean | undefined;
    let seenEntryCount: number | undefined;
    const bucket = makeBucket(uid("first-only-fire"));
    bucket.on("enter", { firstEntryOnly: true }, async (_user, ctx) => {
      seenIsFirstEntry = ctx.isFirstEntry;
      seenEntryCount = ctx.entryCount;
    });
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("first-only-fire-user");
    await seedContact(userId);

    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { entryCount: 1 } },
    );

    expect(seenIsFirstEntry).toBe(true);
    expect(seenEntryCount).toBe(1);
  });
});

// ===========================================================================
// 7 — leave reason filter (scalar + array)
// ===========================================================================

describe("leave reason filter (Test 7)", () => {
  it("skips a leave whose reason does not match the opts.reason", async () => {
    const handler = vi.fn(async () => {});
    const bucket = makeBucket(uid("reason-skip"));
    bucket.on("leave", { reason: "maxDwell" }, handler);
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("reason-skip-user");
    await seedContact(userId);

    // The emitted leave carried reason "criteria"; the filter wants "maxDwell".
    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { reason: "criteria" } },
    );

    expect(handler).not.toHaveBeenCalled();
  });

  it("calls the handler on a matching reason with ctx.reason set", async () => {
    let seenReason: string | undefined;
    const bucket = makeBucket(uid("reason-fire"));
    bucket.on("leave", { reason: "maxDwell" }, async (_user, ctx) => {
      seenReason = ctx.reason;
    });
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("reason-fire-user");
    await seedContact(userId);

    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { reason: "maxDwell" } },
    );

    expect(seenReason).toBe("maxDwell");
  });

  it("array form matches any listed reason", async () => {
    const handler = vi.fn(async () => {});
    const bucket = makeBucket(uid("reason-array"));
    bucket.on("leave", { reason: ["criteria", "maxDwell"] }, handler);
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("reason-array-user");
    await seedContact(userId);

    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { reason: "criteria" } },
    );

    expect(handler).toHaveBeenCalledTimes(1);
  });
});

// ===========================================================================
// 8 — ctx is the full JourneyContext (built by spread, extras layered on)
// ===========================================================================

describe("reaction ctx is full JourneyContext (Test 8)", () => {
  it("exposes every JourneyContext primitive plus the enter extras", async () => {
    let captured:
      | (Record<string, unknown> & { entryCount?: number })
      | undefined;
    const bucket = makeBucket(uid("ctx-full"));
    bucket.on("enter", async (_user, ctx) => {
      captured = ctx as unknown as Record<string, unknown> & {
        entryCount?: number;
      };
    });
    const reaction = bucket.reactions[0];
    if (!reaction) throw new Error("expected a reaction");

    const userId = uid("ctx-full-user");
    await seedContact(userId);

    await runReaction(
      reaction.task as unknown as {
        fn: (i: unknown, c: unknown) => Promise<unknown>;
      },
      { userId, properties: { entryCount: 1 } },
    );

    if (!captured) throw new Error("handler was not called");
    // Full JourneyContext surface — the spread preserves the method references.
    expect(typeof captured.sleep).toBe("function");
    expect(typeof captured.sleepUntil).toBe("function");
    expect(typeof captured.waitForEvent).toBe("function");
    expect(typeof captured.checkpoint).toBe("function");
    expect(typeof captured.trigger).toBe("function");
    expect(typeof captured.identify).toBe("function");
    expect(captured.when).toBeDefined();
    expect(captured.guard).toBeDefined();
    expect(captured.history).toBeDefined();
    // Reaction extras are layered on the SAME object (spread, not a wrapper).
    expect(captured.entryCount).toBe(1);
    expect(captured.isFirstEntry).toBe(true);
  });
});

// ===========================================================================
// 8b — normalizeOnArgs arities (through the public .on() surface)
// ===========================================================================

describe("on() argument arities (Test 8b)", () => {
  it("resolves on(enter, handler) — opts omitted", () => {
    const bucket = makeBucket(uid("arity-enter-h"));
    bucket.on("enter", async () => {});
    expect(bucket.reactions[0]?.meta.id).toBe(
      `bucket-${bucket.meta.id}-on-enter`,
    );
  });

  it("resolves on(enter, opts, handler)", () => {
    const bucket = makeBucket(uid("arity-enter-oh"));
    bucket.on("enter", { firstEntryOnly: true }, async () => {});
    expect(bucket.reactions).toHaveLength(1);
  });

  it("resolves on(dwell, opts, handler)", () => {
    const bucket = makeBucket(uid("arity-dwell-oh"));
    bucket.on("dwell", { after: days(7) }, async () => {});
    expect(bucket.reactions[0]?.meta.reactionKind).toBe("dwell");
  });

  it("throws a TypeError on dwell with missing opts", () => {
    const bucket = makeBucket(uid("arity-dwell-missing"));
    expect(() =>
      // @ts-expect-error — dwell requires mandatory opts (after/every).
      bucket.on("dwell", async () => {}),
    ).toThrow(TypeError);
  });

  it("throws a TypeError on dwell with ambiguous opts (both after + every)", () => {
    const bucket = makeBucket(uid("arity-dwell-ambig"));
    // Exactly one of after/every is allowed — the union type rejects both, and
    // the runtime `normalizeOnArgs` throws. Built as `unknown` so the runtime
    // guard (not the compiler) is what this test exercises.
    const ambiguous = {
      after: days(7),
      every: hours(1),
    } as unknown as Parameters<typeof bucket.on>[1];
    expect(() => bucket.on("dwell", ambiguous, async () => {})).toThrow(
      TypeError,
    );
  });

  it("throws a TypeError when no handler function is supplied", () => {
    const bucket = makeBucket(uid("arity-no-handler"));
    expect(() =>
      // @ts-expect-error — a handler function is required.
      bucket.on("enter", { firstEntryOnly: true }),
    ).toThrow(TypeError);
  });
});

// ===========================================================================
// 12 — container registration (reaction meta lands in the journey registry)
// ===========================================================================

describe("container reaction registration (Test 12)", () => {
  it("registers the reaction meta indexed by its trigger event", () => {
    const bucket = makeBucket(uid("container-reg"));
    bucket.on("enter", async () => {});

    const client = createHogsendClient({ buckets: [bucket] });
    const bound = client.registry.getByTriggerEvent(bucket.entered);
    const reaction = bound.find(
      (j) => j.id === `bucket-${bucket.meta.id}-on-enter`,
    );
    expect(reaction).toBeDefined();
    expect(reaction?.sourceBucketId).toBe(bucket.meta.id);
    expect(reaction?.reactionKind).toBe("enter");
  });
});

// ===========================================================================
// 13 — worker selectors (tasks + journeys for enabled buckets)
// ===========================================================================

describe("worker reaction selectors (Test 13)", () => {
  it("selectBucketReactionTasks returns the reaction task; collect returns the journey", () => {
    const bucket = makeBucket(uid("worker-select"));
    bucket.on("enter", async () => {});

    const tasks = selectBucketReactionTasks([bucket], "*");
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toBe(bucket.reactions[0]?.task);

    const journeys = collectBucketReactionJourneys([bucket], "*");
    expect(journeys).toHaveLength(1);
    expect(journeys[0]).toBe(bucket.reactions[0]);
  });
});

// ===========================================================================
// 14 — ENABLED_BUCKETS gating (bucket-gated, NOT journey-gated)
// ===========================================================================

describe("ENABLED_BUCKETS gating (Test 14)", () => {
  it("excludes the reaction from both selectors AND the registry when its bucket is disabled", () => {
    const bucket = makeBucket(uid("gate-off"));
    bucket.on("enter", async () => {});

    expect(selectBucketReactionTasks([bucket], "other-bucket")).toHaveLength(0);
    expect(
      collectBucketReactionJourneys([bucket], "other-bucket"),
    ).toHaveLength(0);

    const client = createHogsendClient({
      buckets: [bucket],
      enabledBuckets: "other-bucket",
    });
    expect(client.registry.getByTriggerEvent(bucket.entered)).toHaveLength(0);
  });

  it("keeps the reaction when ENABLED_JOURNEYS is a csv but ENABLED_BUCKETS is * (bucket-gated)", () => {
    const bucket = makeBucket(uid("gate-bucket-not-journey"));
    bucket.on("enter", async () => {});

    // A csv ENABLED_JOURNEYS that does NOT contain the reaction id must NOT drop
    // it — reactions follow ENABLED_BUCKETS, never ENABLED_JOURNEYS (Section 9).
    const tasks = selectBucketReactionTasks([bucket], "*");
    expect(tasks).toHaveLength(1);

    const client = createHogsendClient({
      buckets: [bucket],
      enabledJourneys: "someOtherJourney",
      enabledBuckets: "*",
    });
    const reaction = client.registry
      .getByTriggerEvent(bucket.entered)
      .find((j) => j.id === `bucket-${bucket.meta.id}-on-enter`);
    expect(reaction).toBeDefined();
  });
});

// ===========================================================================
// 14b — reaction id collision throws (loud boot failure)
// ===========================================================================

describe("reaction id collision (Test 14b)", () => {
  it("throws when two buckets generate the same reaction id (duplicate bucket id)", () => {
    const id = uid("collide");
    const a = makeBucket(id);
    a.on("enter", async () => {});
    const b = makeBucket(id);
    b.on("enter", async () => {});

    expect(() => selectBucketReactionTasks([a, b], "*")).toThrow(/collision/i);
  });
});

// ===========================================================================
// 15 — admin feedsJourneys (owned reactions + external bindings)
// ===========================================================================

describe("admin feedsJourneys grouping (Test 15)", () => {
  it("surfaces an owned reaction with owned:true and an external binding with owned:false", async () => {
    const { createApp } = await import("@hogsend/engine");

    const bucket = makeBucket(uid("admin-feeds"));
    bucket.on("enter", async () => {});

    // A hand-written journey bound to the bucket's entered alias — an EXTERNAL
    // binding (no sourceBucketId), surfaced owned:false.
    const external = defineJourney({
      meta: {
        id: uid("external-on-enter"),
        name: "External on enter",
        enabled: true,
        trigger: { event: bucket.entered },
        entryLimit: "unlimited",
        suppress: { seconds: 0 },
      },
      run: async () => {},
    });

    const client = createHogsendClient({
      buckets: [bucket],
      journeys: [external],
    });
    const app = createApp(client);

    const res = await app.request(`/v1/admin/buckets/${bucket.meta.id}`, {
      headers: { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    const feeds = body.bucket.feedsJourneys as Array<{
      id: string;
      sourceBucketId: string | null;
      owned: boolean;
    }>;

    const owned = feeds.find(
      (f) => f.id === `bucket-${bucket.meta.id}-on-enter`,
    );
    expect(owned).toBeDefined();
    expect(owned?.owned).toBe(true);
    expect(owned?.sourceBucketId).toBe(bucket.meta.id);

    const ext = feeds.find((f) => f.id === uid("external-on-enter"));
    expect(ext).toBeDefined();
    expect(ext?.owned).toBe(false);
  });
});

// ===========================================================================
// 29 — exitOn migration value-equality guard (reactivation-dormancy)
// ===========================================================================

describe("reactivation-dormancy exitOn migration (Test 29)", () => {
  it("contains the byte-identical went-dormant left transition", async () => {
    const { reactivationDormancy } = await import(
      "../journeys/reactivation-dormancy.js"
    );
    const exitOn = reactivationDormancy.meta.exitOn ?? [];
    expect(exitOn).toContainEqual({ event: "bucket:left:went-dormant" });
  });
});

// ===========================================================================
// 30 — type-level: literal preservation of the typed refs
// ===========================================================================

describe("typed ref literal preservation (Test 30)", () => {
  it("preserves the literal event-name types off the bucket id", () => {
    const wentDormant = defineBucket({
      meta: { id: "went-dormant", name: "Went dormant", enabled: true },
    });
    expectTypeOf(
      wentDormant.entered,
    ).toEqualTypeOf<"bucket:entered:went-dormant">();
    expectTypeOf(wentDormant.left).toEqualTypeOf<"bucket:left:went-dormant">();
  });
});

// ===========================================================================
// 31 — standalone-import smoke (ESM cycle / TDZ regression guard)
// ===========================================================================

describe("standalone journey-module import smoke (Test 31)", () => {
  // Each journey module imported in ISOLATION (not via the barrel). If a typed
  // bucket ref were undefined at module-eval (a TDZ/cycle regression), the
  // trigger.event / exitOn[].event would be empty/undefined — caught here.
  const journeyModules = [
    "../journeys/activation-welcome.js",
    "../journeys/activation-nudge-series.js",
    "../journeys/conversion-trial-upgrade.js",
    "../journeys/conversion-abandoned-checkout.js",
    "../journeys/retention-milestone.js",
    "../journeys/referral-invite.js",
    "../journeys/feedback-nps.js",
    "../journeys/reactivation-dormancy.js",
    "../journeys/churn-prevention.js",
    "../journeys/test-onboarding.js",
  ];

  for (const modulePath of journeyModules) {
    it(`every trigger/exitOn event is a non-empty string in ${modulePath}`, async () => {
      const mod = (await import(modulePath)) as Record<string, unknown>;
      const exported = Object.values(mod).filter(
        (v): v is { meta: { trigger: { event: unknown }; exitOn?: unknown } } =>
          typeof v === "object" &&
          v != null &&
          "meta" in v &&
          typeof (v as { meta?: unknown }).meta === "object",
      );
      expect(exported.length).toBeGreaterThan(0);
      for (const journey of exported) {
        const event = journey.meta.trigger.event;
        expect(typeof event).toBe("string");
        expect((event as string).length).toBeGreaterThan(0);

        const exitOn = (journey.meta.exitOn ?? []) as Array<{ event: unknown }>;
        for (const rule of exitOn) {
          expect(typeof rule.event).toBe("string");
          expect((rule.event as string).length).toBeGreaterThan(0);
        }
      }
    });
  }
});
