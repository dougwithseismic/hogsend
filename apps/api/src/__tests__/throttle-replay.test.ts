/**
 * REAL-Postgres replay proof for `ctx.throttle`.
 *
 * The unit-stub suite (`throttle.test.ts`) exercises the throttle control flow
 * against a hand-rolled db mock; THIS suite drives the REAL `defineJourney`
 * durable-task `fn` against the Docker Postgres on :5434 — real
 * `createTrackedMailer`, a counting `vi.fn` provider, real `recordOnce`
 * jsonb-merge writes, and the real `countRecentSends` COUNT. Only the Hatchet
 * client is mocked (to capture `fn`), so a replay-from-top is modeled by
 * invoking the SAME `fn` twice with the SAME `workflowRunId` — exactly as an
 * eviction-capable engine does.
 *
 * It pins the FM-26 invariant: the advisory verdict is RECORDED set-once, so a
 * replay returns it verbatim even though the run's OWN send has since landed in
 * the counting window (a live re-count would flip allowed→blocked and diverge
 * the branch — the exact class this engine's replay-safety design forbids).
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can drive it
// directly (mirrors digest-replay.test.ts). The holder is `mock`-prefixed so
// vitest allows the hoisted mock factory to close over it.
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
  countRecentSends,
  createHogsendClient,
  createTrackedMailer,
  days,
  defineJourney,
  durationToMs,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
type ThrottleResult = import("@hogsend/core").ThrottleResult;
type DurationObject = import("@hogsend/core").DurationObject;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `throt-${Date.now()}`;
const createdUsers: string[] = [];
function newUser(): string {
  const id = randomUUID();
  createdUsers.push(id);
  return id;
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

// A journey that throttle-checks its user, then sends ONE email only when the
// verdict allows. entryLimit "unlimited" so a fresh run id is a legitimate
// re-enrollment; the SAME run id models a replay-from-top.
function makeThrottleJourney(opts: {
  journeyId: string;
  event: string;
  limit: number;
  window: DurationObject;
  captureInto?: ThrottleResult[];
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "Throttle replay test",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: { hours: 0 },
    },
    run: async (user, ctx) => {
      const verdict = await ctx.throttle({
        limit: opts.limit,
        window: opts.window,
      });
      opts.captureInto?.push(verdict);
      if (verdict.allowed) {
        await sendEmail({
          to: user.email,
          userId: user.id,
          journeyStateId: user.stateId,
          template: "welcome",
          subject: "Throttle",
          props: { name: "Ada" },
        });
      }
    },
  });
}

function registerJourney(journey: ReturnType<typeof defineJourney>) {
  const registry = new JourneyRegistry();
  registry.register(journey.meta);
  setJourneyRegistry(registry);
  return registry;
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

// Base durable ctx: sleepFor/waitFor resolve instantly, workflowRunId fixed so a
// re-drive recovers the same enrollment (replay-from-top). throttle never
// sleeps, so sleepFor is unused here.
function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

// Seed a non-failed email_sends row for the recipient, inside any reasonable
// window (created_at defaults to now). This is what countRecentSends counts.
async function seedSend(userId: string, email: string) {
  await db.insert(emailSends).values({
    userId,
    userEmail: email,
    toEmail: email,
    fromEmail: "noreply@hogsend.com",
    subject: "seed",
    templateKey: "welcome",
    status: "sent",
  });
}

async function readThrottle(
  userId: string,
): Promise<Record<string, ThrottleResult>> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.userId, userId));
  return (row?.context?.__throttle__ ?? {}) as Record<string, ThrottleResult>;
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  // email_sends → journey_states is a plain FK (no cascade), so purge sends
  // first; journey_states cascades journey_logs.
  await db.delete(emailSends).where(inArray(emailSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("ctx.throttle — real-DB replay stability", () => {
  it("replay returns the RECORDED verdict verbatim though the run's own send has since landed in the window (FM-26)", async () => {
    const userId = newUser();
    const email = `${userId}@example.com`;
    const event = `${RUN}-t1`;
    const window = days(7);
    const windowMs = durationToMs(window);
    const limit = 3;

    // Seed limit-1 prior non-failed sends inside the window.
    await seedSend(userId, email);
    await seedSend(userId, email);

    const captured: ThrottleResult[] = [];
    const journey = makeThrottleJourney({
      journeyId: `${RUN}-jt1`,
      event,
      limit,
      window,
      captureInto: captured,
    });
    registerJourney(journey);
    const fn = grabFn();
    const runId = `${RUN}-wfr-t1`;

    // DRIVE 1 — count = 2 (< 3) → allowed; the send lands the 3rd row.
    await fn(input(userId), makeCtx(runId));
    expect(captured).toHaveLength(1);
    expect(captured[0]).toEqual({ allowed: true, count: 2, remaining: 1 });
    expect(providerSends).toHaveLength(1);

    // A LIVE re-count now sees 3 (>= limit) — a re-count on replay WOULD block.
    const liveCount = await countRecentSends({
      db,
      to: email,
      since: new Date(Date.now() - windowMs),
    });
    expect(liveCount).toBe(3);

    // DRIVE 2 — same run id, replay-from-top: the recorded allowed:true verdict
    // is returned verbatim despite the live count now being >= limit.
    await fn(input(userId), makeCtx(runId));
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]);
    expect(captured[1]?.allowed).toBe(true);
    // Same branch ran; the send short-circuited on its idempotency key.
    expect(providerSends).toHaveLength(1);
  });

  it("records the verdict under context.__throttle__ with the <site>:<category|*>:<limit>/<windowMs> key", async () => {
    const userId = newUser();
    const event = `${RUN}-t2`;
    const window = days(7);
    const windowMs = durationToMs(window);
    const limit = 5;

    const journey = makeThrottleJourney({
      journeyId: `${RUN}-jt2`,
      event,
      limit,
      window,
    });
    registerJourney(journey);
    const fn = grabFn();

    await fn(input(userId), makeCtx(`${RUN}-wfr-t2`));

    const bag = await readThrottle(userId);
    // No prior sends → count 0; site defaults to "start" (throttle runs before
    // any wait/checkpoint), category absent → "*".
    const key = `start:*:${limit}/${windowMs}`;
    expect(Object.keys(bag)).toContain(key);
    expect(bag[key]).toMatchObject({ allowed: true, count: 0, remaining: 5 });
  });
});
