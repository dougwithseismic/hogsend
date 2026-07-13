/**
 * Per-journey holdouts (impact plan §4.1 + §4.2): deterministic diversion in
 * the enrollment guard chain, the held_out state row + journey.heldout spine
 * event, and the lift endpoint's honest statistics.
 */
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Config-preserving Hatchet mock that CAPTURES the journey durable fn (the
// journey-once-resume harness pattern) so the guard chain runs for real
// against real Postgres without a live broker.
const { mockFnHolder, hatchetMock } = vi.hoisted(() => {
  type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
  const holder: { fn: CapturedFn | undefined } = { fn: undefined };
  const factory = () => ({
    hatchet: {
      durableTask: vi.fn((config: { fn: CapturedFn }) => {
        holder.fn = config.fn;
        return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
      }),
      task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn(async () => ({})) })),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { mockFnHolder: holder, hatchetMock: factory };
});

vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, emailSends, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq, inArray, like } = await import("drizzle-orm");
const {
  betaWinProbability,
  computeLift,
  createApp,
  createHogsendClient,
  createTrackedMailer,
  defineJourney,
  holdoutBucket,
  isGlobalControl,
  isHeldOut,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const app = createApp(container);
const { db } = container;

const RUN = `hold-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;
const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

/** Probe deterministic buckets for a user on each side of the 50% line. */
function findUser(held: boolean): string {
  for (let i = 0; i < 1000; i++) {
    const candidate = `${RUN}-u${i}`;
    const bucket = holdoutBucket({ userId: candidate, journeyId: JOURNEY_ID });
    if (held ? bucket < 5000 : bucket >= 5000) return candidate;
  }
  throw new Error("no candidate found");
}
const HELD_USER = findUser(true);
const ENTERED_USER = findUser(false);

const journey = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Holdout test",
    enabled: true,
    trigger: { event: "test.holdout.enroll" },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
    holdout: { percent: 50 },
  },
  run: async () => {},
});

const registry = new JourneyRegistry();
registry.register(journey.meta);
setJourneyRegistry(registry);

const input = (userId: string) => ({
  userId,
  userEmail: `${userId}@example.com`,
  properties: {},
});
const ctx = (runId: string) => ({
  workflowRunId: () => runId,
  sleepFor: async () => ({}),
  waitFor: async () => ({}),
  now: async () => new Date(),
});

afterAll(async () => {
  await db.delete(journeyStates).where(eq(journeyStates.journeyId, JOURNEY_ID));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

describe("deterministic holdout assignment (4.1)", () => {
  it("buckets are stable, replay-identical, and clamped", () => {
    const first = holdoutBucket({ userId: "u", journeyId: "j" });
    expect(holdoutBucket({ userId: "u", journeyId: "j" })).toBe(first);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(first).toBeLessThan(10000);
    // Salt rotation re-buckets.
    expect(holdoutBucket({ userId: "u", journeyId: "j", salt: "v2" })).not.toBe(
      first,
    );
    // percent > 50 clamps: a holdout is never the majority.
    const all = Array.from({ length: 200 }, (_, i) =>
      isHeldOut({ userId: `u${i}`, journeyId: "j", percent: 100 }),
    );
    const heldShare = all.filter(Boolean).length / all.length;
    expect(heldShare).toBeLessThan(0.7);
  });

  it("diverts a held-out contact: skipped result, held_out row, spine event, no duplicates", async () => {
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");

    const result = await fn(input(HELD_USER), ctx(`${RUN}-r1`));
    expect(result).toMatchObject({ status: "skipped", reason: "held_out" });

    const rows = await db
      .select()
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, HELD_USER),
          eq(journeyStates.journeyId, JOURNEY_ID),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "held_out" });

    const spine = await db
      .select()
      .from(userEvents)
      .where(
        and(
          eq(userEvents.userId, HELD_USER),
          eq(userEvents.event, "journey.heldout"),
        ),
      );
    expect(spine).toHaveLength(1);
    expect(spine[0]?.properties).toMatchObject({ journeyId: JOURNEY_ID });

    // Re-trigger: diverted again, but NO second row and NO second event.
    const again = await fn(input(HELD_USER), ctx(`${RUN}-r2`));
    expect(again).toMatchObject({ status: "skipped", reason: "held_out" });
    const rowsAfter = await db
      .select()
      .from(journeyStates)
      .where(
        and(
          eq(journeyStates.userId, HELD_USER),
          eq(journeyStates.journeyId, JOURNEY_ID),
        ),
      );
    expect(rowsAfter).toHaveLength(1);
  });

  it("lets a non-held-out contact enter and complete", async () => {
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");
    const result = await fn(input(ENTERED_USER), ctx(`${RUN}-r3`));
    expect(result).toMatchObject({ status: "completed" });
  });
});

describe("lift statistics (4.2)", () => {
  it("betaWinProbability matches the closed form for Beta(2,1) vs Beta(1,2)", () => {
    // P(X>Y) = ∫ 2x·(2x−x²) dx = 4/3 − 1/2 = 5/6.
    expect(betaWinProbability(2, 1, 1, 2)).toBeCloseTo(5 / 6, 3);
    // Symmetry: identical posteriors → 0.5.
    expect(betaWinProbability(3, 7, 3, 7)).toBeCloseTo(0.5, 3);
  });

  it("computeLift suppresses under the combined-conversion floor and flags small samples", () => {
    const suppressedVerdict = computeLift({
      treatment: { contacts: 50, converters: 4 },
      control: { contacts: 50, converters: 2 },
    });
    expect(suppressedVerdict.suppressed).toBe(true);
    expect(suppressedVerdict.winProbability).toBeNull();
    expect(suppressedVerdict.smallSample).toBe(true);
    expect(suppressedVerdict.liftPercent).toBeCloseTo(100, 5);

    const confident = computeLift({
      treatment: { contacts: 1000, converters: 80 },
      control: { contacts: 1000, converters: 40 },
    });
    expect(confident.suppressed).toBe(false);
    expect(confident.smallSample).toBe(false);
    expect(confident.winProbability).toBeGreaterThan(0.99);
  });

  it("serves the lift endpoint over the entered/held-out cohorts", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${JOURNEY_ID}/lift?days=30`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      treatment: { contacts: number };
      control: { contacts: number };
      suppressed: boolean;
      winProbability: number | null;
      smallSample: boolean;
    };
    expect(body.treatment.contacts).toBe(1);
    expect(body.control.contacts).toBe(1);
    // 0 conversions on both sides — suppression floor holds the number back.
    expect(body.suppressed).toBe(true);
    expect(body.winProbability).toBeNull();
    expect(body.smallSample).toBe(true);
  });
});

describe("global control group (4.3)", () => {
  const providerSends: string[] = [];
  const provider: EmailProvider = {
    meta: { id: "resend", name: "control-test" },
    capabilities: { nativeTracking: false },
    send: async (opts) => {
      providerSends.push(String(opts.to));
      return { id: `ctl-msg-${providerSends.length}` };
    },
    sendBatch: async () => ({ results: [] }),
    verifyWebhook: () => {
      throw new Error("unused");
    },
    parseWebhook: () => {
      throw new Error("unused");
    },
  };
  const mailer = createTrackedMailer(
    {
      defaultFrom: "Hogsend <noreply@hogsend.com>",
      // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
      db: db as any,
      templates,
    },
    { provider },
  );

  /** An email deterministically inside/outside the 15% control bucket. */
  function findEmail(controlled: boolean): string {
    process.env.GLOBAL_CONTROL_PERCENT = "15";
    try {
      for (let i = 0; i < 2000; i++) {
        const candidate = `${RUN}-c${i}@example.com`;
        if (isGlobalControl(candidate) === controlled) return candidate;
      }
      throw new Error("no candidate found");
    } finally {
      delete process.env.GLOBAL_CONTROL_PERCENT;
    }
  }

  afterAll(async () => {
    delete process.env.GLOBAL_CONTROL_PERCENT;
    await db.delete(emailSends).where(like(emailSends.toEmail, `${RUN}-c%`));
  });

  it("withholds non-transactional sends for controlled contacts, delivers transactional, and is off by default", async () => {
    const controlled = findEmail(true);
    const uncontrolled = findEmail(false);

    // OFF by default: no env ⇒ everyone sends.
    const offResult = await mailer.send({
      template: "welcome" as never,
      props: { name: "Ada" } as never,
      to: controlled,
      category: "journey",
    });
    expect(offResult.status).toBe("sent");

    process.env.GLOBAL_CONTROL_PERCENT = "15";
    try {
      // Controlled + marketing: withheld, no provider call, no row.
      const before = providerSends.length;
      const withheld = await mailer.send({
        template: "welcome" as never,
        props: { name: "Ada" } as never,
        to: controlled,
        category: "journey",
      });
      expect(withheld).toMatchObject({
        status: "skipped",
        reason: "control_group",
      });
      expect(providerSends.length).toBe(before);

      // Controlled + transactional category: still delivers.
      const transactional = await mailer.send({
        template: "welcome" as never,
        props: { name: "Ada" } as never,
        to: controlled,
        category: "transactional",
      });
      expect(transactional.status).toBe("sent");

      // Uncontrolled contact: unaffected.
      const normal = await mailer.send({
        template: "welcome" as never,
        props: { name: "Ada" } as never,
        to: uncontrolled,
        category: "journey",
      });
      expect(normal.status).toBe("sent");
    } finally {
      delete process.env.GLOBAL_CONTROL_PERCENT;
    }
  });
});
