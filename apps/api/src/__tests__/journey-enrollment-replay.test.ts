/**
 * FULL-fn replay-safety proof — the test the adversarial review demanded.
 *
 * Unlike `journey-run-replay.test.ts` (which re-enters the boundary with a
 * PINNED stateId and so cannot detect a replay-induced stateId change), this
 * suite drives the REAL `defineJourney` durable-task `fn` — including the
 * journey_states INSERT, the enrollment guards, AND the run-id recovery — TWICE
 * for the SAME Hatchet `workflowRunId`, exactly as a replay-from-top does.
 *
 * It proves the FIX for the critical finding: keys are anchored on the replay-
 * stable run id (recovered enrollment), so a replay re-derives the SAME stateId
 * and the SAME idempotency keys even when the prior enrollment row is TERMINAL
 * (the unlimited / once_per_period case the active-state guard misses).
 *
 * NOTHING is mocked on the dedup path: real createTrackedMailer, real Postgres
 * unique index, a counting provider. Only the Hatchet client is stubbed so we
 * can invoke `fn` directly with a controllable `hatchetCtx`.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can invoke it
// directly — the run/runNoWait handles are unused here. The holder is `mock`-
// prefixed so vitest allows the hoisted mock factory to close over it.
type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
const mockFnHolder: { fn: CapturedFn | undefined } = { fn: undefined };
// Mock the ENGINE's hatchet singleton (its internal `../lib/hatchet.js`
// resolves to packages/engine/src/lib/hatchet.ts). A relative path from this
// test file pointing at the same module is what vitest matches against the
// engine's import specifier — a test-local `../lib/hatchet.js` would NOT
// intercept the engine's copy.
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

const RUN = `jer-${Date.now()}`;

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

// A stub hatchetCtx whose workflowRunId() is FIXED — both the original run and
// the replay see the same id, exactly like an in-place durable resume / a
// replay-from-top of the same logical run. sleepFor/waitFor resolve instantly so
// run() flows straight through.
function makeHatchetCtx(workflowRunId: string) {
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
  for (const suffix of ["unlimited", "terminal", "newrun-a", "newrun-b"]) {
    const uid = `${RUN}-${suffix}`;
    await db.delete(emailSends).where(eq(emailSends.userId, uid));
    await db.delete(journeyStates).where(eq(journeyStates.userId, uid));
  }
});

describe("REAL define-journey fn — exactly-once across a full-fn replay", () => {
  // An `unlimited`-entry journey: a single inline send at the top of run(). This
  // is the carrier the review identified (retention-milestone shape) — the
  // active-state guard does NOT block a replay once the prior row is terminal.
  function makeJourney(journeyId: string) {
    return defineJourney({
      meta: {
        id: journeyId,
        name: "Replay test journey",
        enabled: true,
        trigger: { event: "test.enroll" },
        entryLimit: "unlimited",
        suppress: { hours: 0 },
      },
      run: async (user) => {
        await sendEmail({
          to: user.email,
          userId: user.id,
          journeyStateId: user.stateId,
          template: "welcome",
          subject: "Welcome",
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

  it("same workflowRunId twice → ONE enrollment, ONE provider call, ONE row", async () => {
    const userId = `${RUN}-unlimited`;
    const journeyId = `${RUN}-journey-unlimited`;
    const journey = makeJourney(journeyId);
    const registry = new JourneyRegistry();
    registry.register(journey.meta);
    setJourneyRegistry(registry);
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");

    const ctx = makeHatchetCtx(`${RUN}-wfr-unlimited`);

    // ORIGINAL run.
    await fn(input(userId), ctx);
    // REPLAY-FROM-TOP of the SAME run (worker crash / redeploy): same run id.
    await fn(input(userId), ctx);

    // The replay recovered the SAME enrollment (by run id), so the send key
    // collided and the provider was hit ONCE.
    expect(providerSends).toHaveLength(1);

    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);

    const rows = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("replay AFTER the enrollment reached a TERMINAL status still does NOT duplicate", async () => {
    const userId = `${RUN}-terminal`;
    const journeyId = `${RUN}-journey-terminal`;
    const journey = makeJourney(journeyId);
    const registry = new JourneyRegistry();
    registry.register(journey.meta);
    setJourneyRegistry(registry);
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");

    const ctx = makeHatchetCtx(`${RUN}-wfr-terminal`);

    // ORIGINAL run — completes, flipping the row to status='completed'.
    const result = (await fn(input(userId), ctx)) as {
      status: string;
    };
    expect(result.status).toBe("completed");

    // The active-state guard now MISSES the terminal row. Without run-id
    // recovery a fresh stateId would be minted → a non-colliding key → a second
    // delivery. With the fix, the replay recovers the same enrollment.
    await fn(input(userId), ctx);

    expect(providerSends).toHaveLength(1);
    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);
    const rows = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it("a genuinely NEW run (distinct workflowRunId) DOES re-enroll and send again", async () => {
    // Scope clarification: exactly-once is scoped to replays of the SAME run.
    // An unlimited journey re-triggered as a DISTINCT durable run is a new
    // enrollment and SHOULD send again — proving we did not over-dedup.
    const userId = `${RUN}-newrun-a`;
    const journeyId = `${RUN}-journey-newrun`;
    const journey = makeJourney(journeyId);
    const registry = new JourneyRegistry();
    registry.register(journey.meta);
    setJourneyRegistry(registry);
    const fn = mockFnHolder.fn;
    if (!fn) throw new Error("durable fn was not captured");

    await fn(input(userId), makeHatchetCtx(`${RUN}-wfr-new-1`));
    // The first enrollment is terminal (completed). A NEW run id = a new
    // enrollment for an unlimited journey.
    await fn(input(userId), makeHatchetCtx(`${RUN}-wfr-new-2`));

    expect(providerSends).toHaveLength(2);
    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(2);
  });
});
