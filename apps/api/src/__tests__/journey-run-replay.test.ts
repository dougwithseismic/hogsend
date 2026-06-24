/**
 * END-TO-END replay-safety proof: a REAL journey `run()` body, driven through the
 * REAL journey boundary, the REAL `createTrackedMailer`, and the REAL Postgres
 * `email_sends_idempotency_key_idx` unique constraint — re-executed from the top
 * to mimic a Hatchet replay-from-top (worker crash / OOM / redeploy).
 *
 * This complements `journey-replay.test.ts` (which proves the key derivation in
 * isolation with a mock email service): here NOTHING is mocked on the dedup
 * path. We author a journey body the way `apps/api/src/journeys/*` author one —
 * inline `sendEmail()` sitting between `ctx.checkpoint`/`ctx.sleep` waits — and
 * assert that running that exact body TWICE against the same enrollment
 * (`stateId`) delivers EXACTLY ONE provider call and leaves EXACTLY ONE
 * `email_sends` row per logical send.
 *
 * The boundary is what `define-journey.ts` wraps `options.run(user, ctx)` in
 * (see define-journey.ts:267-275). A Hatchet replay re-enters that scope from
 * the top with the SAME persisted `stateId`, so we simulate it faithfully by
 * re-entering `runWithJourneyBoundary` with a FRESH boundary (new `seenKeys`)
 * pinned to the same `stateId` and re-driving the same `run`.
 *
 * Mirrors the existing DB-backed harness: one TimescaleDB instance (port 5434),
 * RUN-namespaced rows, full cleanup in afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { emailSends, journeyStates } = await import("@hogsend/db");
const { eq } = await import("drizzle-orm");
const {
  createHogsendClient,
  createJourneyContext,
  createMemoize,
  createTrackedMailer,
  runWithJourneyBoundary,
  sendEmail,
  setEmailService,
} = await import("@hogsend/engine");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;
type EmailProvider = import("@hogsend/engine").EmailProvider;
type JourneyContext = import("@hogsend/core/types").JourneyContext;
type JourneyUser = import("@hogsend/core/types").JourneyUser;
const { templates } = await import("../emails/index.js");

// Mock hatchet only so createJourneyContext / the container can be built; the
// dedup path under test never touches it (Layer 2 is pure Postgres).
const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: async () => {} },
  runs: { cancel: () => {}, get: () => {} },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `jrr-${Date.now()}`;

// A REAL EmailProvider whose only job is to COUNT provider.send() calls. If the
// engine's unique-index short-circuit works, a replayed send never reaches it.
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

// Install the REAL createTrackedMailer as the engine's email service so the
// standalone `sendEmail()` journeys call routes through render → preferences →
// tracking → email_sends → provider.send, exactly as in production.
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

/** Seed a real journey_states row (email_sends.journey_state_id FK targets it). */
async function seedState(userId: string, journeyId: string): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      currentNodeId: "start",
      status: "active",
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

/** Build the boundary define-journey wraps run() in (fresh per replay). */
function makeBoundary(stateId: string, runAnchor?: string): JourneyBoundary {
  return {
    stateId,
    // The replay-stable anchor. Tests that simulate a replay of the SAME run
    // pass a fixed runAnchor for both passes (so keys collide); tests modeling a
    // NEW run pass distinct anchors. Defaults to stateId for the simple case.
    runAnchor: runAnchor ?? stateId,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    memoize: createMemoize({}),
  };
}

/** Build a real journey context wired to the container db + mock hatchet. */
function makeCtx(stateId: string, userId: string): JourneyContext {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    hatchet: mockHatchet as Parameters<
      typeof createJourneyContext
    >[0]["hatchet"],
    hatchetCtx: {
      sleepFor: (async () => ({})) as unknown as (
        d: unknown,
      ) => Promise<unknown>,
      waitFor: (async () => ({})) as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal registry stub
    registry: { get: () => undefined } as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: () => {}, warn: () => {}, error: () => {} } as any,
    stateId,
    userId,
    userEmail: `${userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
  }) as unknown as JourneyContext;
}

// Fresh mailer + provider call counter per test so each test's exactly-once
// assertion counts only its own provider sends.
beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  for (const suffix of ["w", "branch-a", "branch-b"]) {
    const uid = `${RUN}-${suffix}`;
    await db.delete(emailSends).where(eq(emailSends.userId, uid));
    await db.delete(journeyStates).where(eq(journeyStates.userId, uid));
  }
});

describe("REAL journey run() body — exactly-once across a simulated replay", () => {
  // The journey body authors EXACTLY like apps/api/src/journeys/activation-welcome.ts:
  // an inline sendEmail() between durable waits. `ctx.checkpoint` advances the
  // boundary label (the "site" the send inherits) — no idempotencyKey is ever
  // authored. This is the ZERO-authoring-change common case.
  const run = async (user: JourneyUser, ctx: JourneyContext): Promise<void> => {
    await ctx.checkpoint("welcome-step");
    await sendEmail({
      to: user.email,
      userId: user.id,
      journeyStateId: user.stateId,
      template: "welcome",
      subject: "Welcome to Hogsend",
      props: { name: "Ada" },
    });
  };

  it("re-running run() with the same stateId → ONE provider call, ONE row", async () => {
    const userId = `${RUN}-w`;
    const stateId = await seedState(userId, `${RUN}-journey-w`);
    const user: JourneyUser = {
      id: userId,
      email: `${userId}@example.com`,
      properties: {},
      stateId,
      journeyId: `${RUN}-journey-w`,
      journeyName: "welcome",
    };

    // ORIGINAL run — define-journey wraps run() in the boundary.
    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(user, makeCtx(stateId, userId)),
    );

    // WORKER CRASH → Hatchet replays the durable task from the top → run() body
    // re-executes with the SAME persisted stateId and a FRESH boundary.
    await runWithJourneyBoundary(makeBoundary(stateId), () =>
      run(user, makeCtx(stateId, userId)),
    );

    // EXACTLY-ONCE: the provider wire was hit ONCE — the replay short-circuited
    // at the email_sends unique index (no mock standing in for the dedup).
    expect(providerSends).toHaveLength(1);

    // And the DB holds EXACTLY ONE email_sends row for this enrollment.
    const rows = await db
      .select({ id: emailSends.id, status: emailSends.status })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("sent");
  });

  // Proves the fix does NOT over-dedup: a replay that legitimately takes a
  // DIFFERENT branch (different template) still delivers each branch once. The
  // boundary key is content-derived, so distinct templates => distinct keys.
  it("a replay that branch-flips to a different template still sends each once", async () => {
    const userIdA = `${RUN}-branch-a`;
    const userIdB = `${RUN}-branch-b`;
    const stateA = await seedState(userIdA, `${RUN}-journey-branch-a`);
    const stateB = await seedState(userIdB, `${RUN}-journey-branch-b`);

    // run() whose branch depends on a flag — mimics ctx.history.hasEvent /
    // ctx.guard.isSubscribed LIVE reads that can flip between original + replay.
    const branchingRun = async (
      user: JourneyUser,
      ctx: JourneyContext,
      tookAdvanced: boolean,
    ): Promise<void> => {
      await ctx.checkpoint("decide");
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: tookAdvanced ? "activation-nudge" : "welcome",
        subject: tookAdvanced ? "Try this next" : "Welcome",
        props: { name: "Ada" },
      });
    };

    const userA: JourneyUser = {
      id: userIdA,
      email: `${userIdA}@example.com`,
      properties: {},
      stateId: stateA,
      journeyId: `${RUN}-journey-branch-a`,
      journeyName: "branch",
    };

    // ORIGINAL run takes the "welcome" branch.
    await runWithJourneyBoundary(makeBoundary(stateA), () =>
      branchingRun(userA, makeCtx(stateA, userIdA), false),
    );
    // REPLAY of the SAME enrollment diverges to the "activation-nudge" branch
    // (live read flipped). Distinct template => distinct key => NOT deduped
    // against the welcome, NOT a duplicate of it either.
    await runWithJourneyBoundary(makeBoundary(stateA), () =>
      branchingRun(userA, makeCtx(stateA, userIdA), true),
    );

    // Both branches delivered exactly once (2 provider calls, 2 rows) — the fix
    // kills DUPLICATES of the SAME logical send, never a genuinely different one.
    expect(providerSends).toHaveLength(2);
    const rowsA = await db
      .select({ id: emailSends.id })
      .from(emailSends)
      .where(eq(emailSends.userId, userIdA));
    expect(rowsA).toHaveLength(2);

    // Sanity: a DIFFERENT enrollment is never wrongly deduped against userA.
    const userB: JourneyUser = {
      id: userIdB,
      email: `${userIdB}@example.com`,
      properties: {},
      stateId: stateB,
      journeyId: `${RUN}-journey-branch-b`,
      journeyName: "branch",
    };
    await runWithJourneyBoundary(makeBoundary(stateB), () =>
      branchingRun(userB, makeCtx(stateB, userIdB), false),
    );
    expect(providerSends).toHaveLength(3);
  });
});
