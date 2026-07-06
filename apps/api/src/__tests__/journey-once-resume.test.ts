/**
 * REGRESSION: a `once`-entry journey must RESUME after an eviction-driven
 * replay-from-top — it must not be skipped by its own entry-limit guard.
 *
 * Background: on an eviction-capable Hatchet engine (hatchet-lite >= v0.80.0,
 * prod runs v0.84.0) every `ctx.sleep`/`ctx.waitFor` EVICTS the durable task and
 * REPLAYS `fn` from the top on resume. On that replay, the enrollment guards at
 * the top of `define-journey`'s `fn` re-run against live state. For
 * `entryLimit: "once"`, `checkEntryLimit` finds the row the ORIGINAL entry
 * created and returns `{ allowed: false }`, so the resume returns `skipped` and
 * the journey NEVER progresses past its first sleep — every send after the first
 * silently vanishes and the row is stranded in `waiting`. This is the prod
 * symptom: multi-step `once` journeys (docs-subscriber, course-convert) stop
 * completing, while short / `unlimited` journeys are unaffected.
 *
 * The existing `journey-enrollment-replay.test.ts` only exercises `unlimited`
 * journeys (the double-send case), so this path was a blind spot. This suite
 * drives the REAL `defineJourney` durable `fn` against REAL Postgres, models an
 * eviction at the first sleep, then a replay-from-top resume, and asserts the
 * journey resumes, sends its second email exactly once (Layer-2 dedup absorbs
 * the replayed first send), and completes.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFnHolder: { fn: CapturedFn | undefined } = { fn: undefined };
vi.mock("../../../../packages/engine/src/lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn((cfg: { fn: CapturedFn }) => {
      mockFnHolder.fn = cfg.fn;
      return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
    }),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn(async () => {}) },
    runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { emailSends, journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createTrackedMailer,
  defineJourney,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `jresume-${Date.now()}`;

let providerSends: Array<{ to: string | string[] }> = [];
function makeCountingProvider(): EmailProvider {
  let n = 0;
  return {
    meta: { id: "resend", name: "counting-test" },
    capabilities: { nativeTracking: false },
    send: async (opts) => {
      providerSends.push({ to: opts.to });
      n += 1;
      return { id: `prov-msg-${n}` };
    },
    sendBatch: async () => ({ results: [] }),
    verifyWebhook: () => {
      throw new Error("unused");
    },
    parseWebhook: () => {
      throw new Error("unused");
    },
  };
}

function installRealMailer() {
  providerSends = [];
  const mailer = createTrackedMailer(
    {
      defaultFrom: "Hogsend <noreply@hogsend.com>",
      // biome-ignore lint/suspicious/noExplicitAny: real container db threaded in
      db: db as any,
      templates,
    },
    { provider: makeCountingProvider() },
  );
  // biome-ignore lint/suspicious/noExplicitAny: mailer satisfies EmailService
  setEmailService(mailer as any);
}

// A `once` journey with a sleep BETWEEN two sends — the minimal shape that
// exercises a mid-flight resume. Distinct nearest labels ("pre-a" vs "gap")
// give the two sends distinct idempotency sites, so the replayed first send
// dedups (Layer 2) while the second send is new.
function makeOnceJourney(journeyId: string) {
  return defineJourney({
    meta: {
      id: journeyId,
      name: "Once resume test",
      enabled: true,
      trigger: { event: "test.enroll" },
      entryLimit: "once",
      suppress: { hours: 0 },
    },
    run: async (user, ctx) => {
      await ctx.checkpoint("pre-a");
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "welcome",
        subject: "A",
        props: { name: "Ada" },
      });
      await ctx.sleep({ duration: { seconds: 1 }, label: "gap" });
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "welcome",
        subject: "B",
        props: { name: "Ada" },
      });
    },
  });
}

function input(userId: string) {
  return {
    userId,
    userEmail: `${userId}@example.com`,
    properties: {},
  };
}

// Resume ctx: sleepFor/waitFor resolve instantly (the wait has "already
// elapsed"), workflowRunId fixed so the replay recovers the same enrollment.
function makeResumeCtx(workflowRunId: string) {
  return {
    workflowRunId: () => workflowRunId,
    sleepFor: async () => ({}),
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  const uid = `${RUN}-once`;
  await db.delete(emailSends).where(eq(emailSends.userId, uid));
  await db.delete(journeyStates).where(eq(journeyStates.userId, uid));
});

describe("once-entry journey resumes across an eviction replay-from-top", () => {
  it("sends A, evicts at the sleep, replays from top, resumes → sends B, completes", async () => {
    const userId = `${RUN}-once`;
    const journeyId = `${RUN}-journey-once`;
    const journey = makeOnceJourney(journeyId);
    const registry = new JourneyRegistry();
    registry.register(journey.meta);
    setJourneyRegistry(registry);
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");

    const runId = `${RUN}-wfr-once`;

    // ORIGINAL invocation — model an eviction at the first sleep. `sleepFor`
    // never resolves (worker slot freed, fn torn down mid-flight). A latch
    // resolved at the sleep call gives us a DETERMINISTIC sync point: by the time
    // it fires, `checkpoint("pre-a")`, send A, and `enterWait` (status→waiting)
    // have all run.
    let sleepReached: () => void = () => {};
    const sleepGate = new Promise<void>((res) => {
      sleepReached = res;
    });
    const evictCtx = {
      workflowRunId: () => runId,
      sleepFor: () => {
        sleepReached();
        return new Promise(() => {}); // never resolves == evicted
      },
      waitFor: () => new Promise(() => {}),
      now: async () => new Date(),
    };
    // Do NOT await to completion — abandon it mid-sleep, exactly like eviction.
    void fn(input(userId), evictCtx);
    await sleepGate;

    // Pre-sleep work landed: send A fired, the row is parked in "waiting".
    expect(providerSends).toHaveLength(1);
    const [mid] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(mid?.status).toBe("waiting");

    // RESUME — Hatchet replays fn FROM THE TOP with the same run id; the sleep
    // has now elapsed (resolves instantly).
    const result = (await fn(input(userId), makeResumeCtx(runId))) as {
      status: string;
    };

    // The journey must RESUME (not be skipped by its own entry guard): it sends
    // B and completes. The replayed send A dedups via the Layer-2 unique index,
    // so the provider is hit exactly twice total (A once, B once).
    expect(result.status).toBe("completed");
    expect(providerSends).toHaveLength(2);

    const [final] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(final?.status).toBe("completed");

    // Exactly one enrollment row, exactly two email_sends (A, B) — no duplicate.
    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);
    const sends = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(sends).toHaveLength(2);
  });
});
