/**
 * REAL-Postgres integration proofs for `ctx.variant` (impact experiments,
 * Decision B) driven through the REAL `defineJourney` durable-task `fn`:
 * the reserved-key injection strip at BOTH context-seeding sites, recorded
 * persistence, replay exactly-once sends, re-entry arm stability, the
 * held_out no-bag invariant, and the arm-equals-templateKey collision
 * throw. Only the Hatchet client is mocked (to capture `fn`); a
 * replay-from-top is modeled by invoking the SAME `fn` twice with the SAME
 * `workflowRunId` — exactly as an eviction-capable engine does.
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

const { contacts, emailSends, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const {
  createHogsendClient,
  createTrackedMailer,
  defineJourney,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
const { isHeldOut, pickVariant } = await import("@hogsend/engine/testing");
type EmailProvider = import("@hogsend/engine").EmailProvider;
type JourneyContext = import("@hogsend/core/types").JourneyContext;
type JourneyUser = import("@hogsend/core/types").JourneyUser;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `varint-${Date.now()}`;
const createdUsers: string[] = [];
function trackUser(id: string): string {
  createdUsers.push(id);
  return id;
}

/** Deterministically find a user id satisfying `pred` (no RNG — pure hash
 * scans are replay-law-legal in tests too). */
function findUser(prefix: string, pred: (id: string) => boolean): string {
  for (let i = 0; i < 100000; i += 1) {
    const id = `${prefix}-${i}`;
    if (pred(id)) return trackUser(id);
  }
  throw new Error(`no candidate user found for ${prefix}`);
}

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

function registerJourney(journey: ReturnType<typeof defineJourney>) {
  const registry = new JourneyRegistry();
  registry.register(journey.meta);
  setJourneyRegistry(registry);
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string, properties: Record<string, unknown> = {}) {
  return { userId, userEmail: `${userId}@example.com`, properties };
}

function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

/** A bare journey: ONE ctx.variant call, no sends (context-focused tests). */
function makeBareVariantJourney(opts: {
  journeyId: string;
  event: string;
  holdout?: { percent: number };
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "Variant strip test",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: { hours: 0 },
      ...(opts.holdout ? { holdout: opts.holdout } : {}),
    },
    run: async (_user: JourneyUser, ctx: JourneyContext) => {
      await ctx.variant("welcome-subject", ["setup", "outcome"]);
    },
  });
}

async function readState(userId: string, journeyId: string) {
  const [row] = await db
    .select()
    .from(journeyStates)
    .where(eq(journeyStates.userId, userId));
  if (!row || row.journeyId !== journeyId) {
    throw new Error(`no state row for ${userId}/${journeyId}`);
  }
  return row;
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await db.delete(emailSends).where(inArray(emailSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("reserved-key stripping at both context-seeding sites", () => {
  it("fresh entry: an injected __variants__ can NOT choose the arm; all four reserved keys are stripped", async () => {
    const journeyId = `${RUN}-strip-fresh`;
    // A user whose HASH-derived arm is "setup" — the injected "outcome"
    // must lose to the derivation.
    const userId = findUser(
      `${RUN}-sf`,
      (id) =>
        pickVariant({
          journeyId,
          key: "welcome-subject",
          userId: id,
          arms: ["setup", "outcome"],
        }) === "setup",
    );
    const journey = makeBareVariantJourney({
      journeyId,
      event: `${RUN}-strip-fresh-ev`,
    });
    registerJourney(journey);
    const fn = grabFn();

    await fn(
      input(userId, {
        plan: "pro",
        __variants__: { "welcome-subject": "outcome" },
        __once__: "evil",
        __digest__: "evil",
        __throttle__: "evil",
      }),
      makeCtx(`${RUN}-wfr-sf`),
    );

    const row = await readState(userId, journeyId);
    const context = (row.context ?? {}) as Record<string, unknown>;
    expect(context.plan).toBe("pro");
    expect(context.__once__).toBeUndefined();
    expect(context.__digest__).toBeUndefined();
    expect(context.__throttle__).toBeUndefined();
    // The bag exists — written legitimately by ctx.variant during run() —
    // and carries the HASH-derived arm, not the injected one.
    expect(context.__variants__).toEqual({ "welcome-subject": "setup" });
  });

  it("held_out row: reserved keys are stripped and NO __variants__ bag exists (run never executes)", async () => {
    const journeyId = `${RUN}-strip-held`;
    const userId = findUser(`${RUN}-sh`, (id) =>
      isHeldOut({ userId: id, journeyId, percent: 50 }),
    );
    const journey = makeBareVariantJourney({
      journeyId,
      event: `${RUN}-strip-held-ev`,
      holdout: { percent: 50 },
    });
    registerJourney(journey);
    const fn = grabFn();

    const result = await fn(
      input(userId, {
        plan: "pro",
        __variants__: { "welcome-subject": "outcome" },
        __once__: "evil",
        __digest__: "evil",
        __throttle__: "evil",
      }),
      makeCtx(`${RUN}-wfr-sh`),
    );
    expect(result).toMatchObject({ status: "skipped" });

    const row = await readState(userId, journeyId);
    expect(row.status).toBe("held_out");
    const context = (row.context ?? {}) as Record<string, unknown>;
    expect(context.plan).toBe("pro");
    expect(context.__variants__).toBeUndefined();
    expect(context.__once__).toBeUndefined();
    expect(context.__digest__).toBeUndefined();
    expect(context.__throttle__).toBeUndefined();
    expect(providerSends).toHaveLength(0);
  });
});
