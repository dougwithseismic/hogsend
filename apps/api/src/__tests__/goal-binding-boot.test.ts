/**
 * `meta.goal` boot validation (Impact Experiments D3, boot half).
 *
 * A journey's `goal` is a conversion-definition id the lift/impact readouts
 * will default to (route defaulting lands in phase 2a). The container
 * boot-validates every DEFINED journey's goal against the ACTUAL conversion
 * registry — fail CLOSED: a typo'd id matches zero conversion rows, so every
 * default readout would quietly report 0% for both cohorts; a boot crash is
 * strictly better than a wrong-but-plausible number.
 *
 * Pinned here:
 *  1. THROW path — unknown goal throws naming the journey id, the bad goal,
 *     and the known-id list ("none" when the registry is empty); the
 *     HOGSEND_DEFAULT_REVENUE_CONVERSION hint appears ONLY when the goal is
 *     literally "revenue"; DISABLED (`enabled: false`) journeys AND journeys
 *     excluded by ENABLED_JOURNEYS are still validated — the loop runs over
 *     DEFINED journeys (opts.journeys), not the registry.
 *  2. ACCEPT path — an authored-conversion goal boots; the seeded
 *     zero-config "revenue" conversion counts, and counts ONLY when actually
 *     seeded (env opt-out without a replacement throws; an authored
 *     id:"revenue" replacement boots); journeys without a goal skip
 *     validation entirely; a validated goal round-trips through the journey
 *     registry (`client.registry.get(id)?.goal` — the D0 schema fix).
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { describe, expect, it, vi } from "vitest";

// defineJourney builds a Hatchet durable task at definition time; mock the
// hatchet client so no gRPC/token is touched (mirrors journey-category.test.ts).
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { defineConversion } = await import("@hogsend/core");
const { createHogsendClient, days, defineJourney } = await import(
  "@hogsend/engine"
);

/** An authored conversion the fixtures validate against. */
const signupConversion = defineConversion({
  id: "signup-completed",
  name: "Signup completed",
  trigger: { event: "signup.completed" },
});

function goalJourney(opts: {
  id: string;
  goal?: string;
  enabled?: boolean;
}): ReturnType<typeof defineJourney> {
  return defineJourney({
    meta: {
      id: opts.id,
      name: "Goal boot fixture",
      enabled: opts.enabled ?? true,
      trigger: { event: "goal.boot" },
      entryLimit: "unlimited",
      suppress: days(0),
      ...(opts.goal !== undefined ? { goal: opts.goal } : {}),
    },
    // Never executes in a boot test.
    run: async () => {},
  });
}

type BootOpts = Parameters<typeof createHogsendClient>[0];

/**
 * Boot and return the thrown Error (undefined when boot succeeded). A
 * successful boot in a throw-path test leaks a pg pool — close best-effort.
 */
function bootError(opts: BootOpts): Error | undefined {
  try {
    const client = createHogsendClient(opts);
    void client.dbClient.end({ timeout: 5 }).catch(() => {});
    return undefined;
  } catch (e) {
    return e as Error;
  }
}

describe("meta.goal boot validation — THROW path", () => {
  it("throws for an unknown goal, naming journey id + goal + the known-id list (no revenue hint)", () => {
    const err = bootError({
      journeys: [goalJourney({ id: "goal-typo", goal: "signup-complete" })],
      conversions: [signupConversion],
    });
    expect(err).toBeDefined();
    expect(err?.message).toContain('Journey "goal-typo"');
    expect(err?.message).toContain('goal "signup-complete"');
    // Known-id list = authored ids, then the seeded built-in (constructor
    // order: [...authoredConversions, defaultRevenueConversion]).
    expect(err?.message).toContain("(known: signup-completed, revenue)");
    // Hint rule: the opt-out hint appears ONLY for a literal "revenue" goal.
    expect(err?.message).not.toContain("HOGSEND_DEFAULT_REVENUE_CONVERSION");
  });

  it('reports "(known: none)" when the conversion registry is empty', () => {
    process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION = "false";
    try {
      const err = bootError({
        journeys: [
          goalJourney({ id: "goal-none-known", goal: "not-a-conversion" }),
        ],
      });
      expect(err).toBeDefined();
      expect(err?.message).toContain('Journey "goal-none-known"');
      expect(err?.message).toContain("(known: none)");
      expect(err?.message).not.toContain("HOGSEND_DEFAULT_REVENUE_CONVERSION");
    } finally {
      // `delete`, never `= undefined` (Node coerces that to the STRING
      // "undefined") — and this var is read off process.env at CLIENT-CREATE
      // time (container.ts), not module load, so per-test set/delete is safe.
      delete process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION;
    }
  });

  it('seed opt-out flips validity: goal "revenue" without a replacement throws WITH the hint', () => {
    process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION = "false";
    try {
      const err = bootError({
        journeys: [goalJourney({ id: "goal-revenue-optout", goal: "revenue" })],
      });
      expect(err).toBeDefined();
      expect(err?.message).toContain('Journey "goal-revenue-optout"');
      expect(err?.message).toContain('goal "revenue"');
      expect(err?.message).toContain(
        "Remove HOGSEND_DEFAULT_REVENUE_CONVERSION=false",
      );
      expect(err?.message).toContain('author an id: "revenue" definition');
    } finally {
      delete process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION;
    }
  });

  it("validates DISABLED journeys (meta.enabled: false) too", () => {
    const err = bootError({
      journeys: [
        goalJourney({
          id: "goal-disabled",
          goal: "not-a-conversion",
          enabled: false,
        }),
      ],
      conversions: [signupConversion],
    });
    expect(err).toBeDefined();
    expect(err?.message).toContain('Journey "goal-disabled"');
    expect(err?.message).toContain('goal "not-a-conversion"');
  });

  it("validates journeys EXCLUDED by ENABLED_JOURNEYS (DEFINED, not just registered)", () => {
    // Two DEFINED journeys; the filter enables only the good one (the filter
    // itself throws on ids matching no defined journey, so it must name a
    // real one — journeys/registry.ts resolveEnabledFilter). The excluded
    // journey never registers, but the loop runs over opts.journeys, so its
    // bad goal must still refuse boot.
    const err = bootError({
      journeys: [
        goalJourney({ id: "goal-enabled-ok" }),
        goalJourney({ id: "goal-excluded", goal: "not-a-conversion" }),
      ],
      conversions: [signupConversion],
      enabledJourneys: "goal-enabled-ok",
    });
    expect(err).toBeDefined();
    expect(err?.message).toContain('Journey "goal-excluded"');
    expect(err?.message).toContain('goal "not-a-conversion"');
  });
});

describe("meta.goal boot validation — ACCEPT path", () => {
  it("boots with an authored-conversion goal and round-trips it through the registry", async () => {
    const client = createHogsendClient({
      journeys: [goalJourney({ id: "goal-ok", goal: "signup-completed" })],
      conversions: [signupConversion],
    });
    // Round-trip (depends on 1a's journeyMetaSchema fix): register() must
    // NOT strip `goal` from the validated meta.
    expect(client.registry.get("goal-ok")?.goal).toBe("signup-completed");
    await client.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it('boots with goal "revenue" against the SEEDED zero-config conversion', async () => {
    const client = createHogsendClient({
      journeys: [goalJourney({ id: "goal-revenue-seeded", goal: "revenue" })],
    });
    expect(client.registry.get("goal-revenue-seeded")?.goal).toBe("revenue");
    await client.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it('boots with goal "revenue" against an AUTHORED id:"revenue" replacement (seed suppressed)', async () => {
    const authoredRevenue = defineConversion({
      id: "revenue",
      name: "Authored revenue",
      trigger: { event: "order.completed" },
    });
    const client = createHogsendClient({
      journeys: [goalJourney({ id: "goal-revenue-authored", goal: "revenue" })],
      conversions: [authoredRevenue],
    });
    expect(client.registry.get("goal-revenue-authored")?.goal).toBe("revenue");
    await client.dbClient.end({ timeout: 5 }).catch(() => {});
  });

  it("skips journeys without a goal — boots even with an EMPTY conversion registry", async () => {
    process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION = "false";
    try {
      const client = createHogsendClient({
        journeys: [goalJourney({ id: "goal-absent" })],
      });
      expect(client.registry.get("goal-absent")?.goal).toBeUndefined();
      await client.dbClient.end({ timeout: 5 }).catch(() => {});
    } finally {
      delete process.env.HOGSEND_DEFAULT_REVENUE_CONVERSION;
    }
  });
});
