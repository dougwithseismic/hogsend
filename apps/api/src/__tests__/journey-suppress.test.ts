/**
 * REAL-Postgres proof for `meta.suppress` enforcement (Phase 5).
 *
 * `JourneyMeta.suppress` is a per-recipient min-gap flooding guard enforced at
 * SEND TIME inside the engine-owned tracked mailer. This suite drives the REAL
 * `defineJourney` durable-task `fn` against the Docker Postgres on :5434 — real
 * `createTrackedMailer`, a counting `vi.fn` provider, real `recordOnce`
 * jsonb-merge writes, the real cross-enrollment `journey_states` join — mirroring
 * the digest-replay / throttle-replay harnesses. Only the Hatchet client is
 * mocked (to capture `fn`), so a replay-from-top is a second `fn` call with the
 * SAME `workflowRunId`.
 *
 * Invariants pinned: a re-enrollment inside the window is skipped
 * (`journey_suppressed`, no row, run still completes); a send older than the
 * window is allowed; a zero suppress disables the guard; suppress is per-JOURNEY
 * (cross-journey isolation) and per-JOURNEY-boundary (non-journey sends are
 * unaffected); the verdict is RECORDED set-once so a replay is stable even if the
 * blocking row is purged; failed rows never suppress.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can drive it
// directly (mirrors throttle-replay.test.ts). The holder is `mock`-prefixed so
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
  createHogsendClient,
  createTrackedMailer,
  days,
  defineJourney,
  hours,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
type DurationObject = import("@hogsend/core").DurationObject;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db } = container;

const RUN = `suppr-${Date.now()}`;
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

// A journey that sends ONE email on entry. entryLimit "unlimited" so a fresh run
// id is a legitimate re-enrollment; the SAME run id models a replay-from-top.
function makeSuppressJourney(opts: {
  journeyId: string;
  event: string;
  suppress: DurationObject;
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "Suppress test",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: opts.suppress,
    },
    run: async (user) => {
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "welcome",
        subject: "Suppress",
        props: { name: "Ada" },
      });
    },
  });
}

function registerJourneys(
  ...journeys: Array<ReturnType<typeof defineJourney>>
): void {
  const registry = new JourneyRegistry();
  for (const j of journeys) registry.register(j.meta);
  setJourneyRegistry(registry);
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

// Base durable ctx: sleepFor/waitFor resolve instantly; workflowRunId fixed so a
// re-drive recovers the same enrollment (replay-from-top).
function makeCtx(runId: string): Record<string, unknown> {
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {},
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

// Seed a terminal (completed) enrollment so its sends attribute to the journey
// WITHOUT blocking a fresh entry (the partial unique index covers only
// active/waiting). A distinct hatchetRunId keeps a fresh drive from recovering
// it — we want a NEW entry, not a resume.
async function seedCompletedEnrollment(opts: {
  journeyId: string;
  userId: string;
  email: string;
}): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: opts.userId,
      userEmail: opts.email,
      journeyId: opts.journeyId,
      currentNodeId: "end-completed",
      status: "completed",
      context: {},
      completedAt: new Date(),
      hatchetRunId: `${RUN}-seed-${randomUUID()}`,
    })
    .returning({ id: journeyStates.id });
  if (!row) throw new Error("failed to seed enrollment");
  return row.id;
}

// Seed a non-failed email_sends row attributed to a journey enrollment, with an
// explicit created_at + status (this is what the suppress EXISTS check joins to).
async function seedSend(opts: {
  userId: string;
  email: string;
  journeyStateId: string;
  createdAt?: Date;
  status?: "sent" | "failed";
}) {
  await db.insert(emailSends).values({
    userId: opts.userId,
    userEmail: opts.email,
    toEmail: opts.email,
    fromEmail: "noreply@hogsend.com",
    subject: "seed",
    templateKey: "welcome",
    journeyStateId: opts.journeyStateId,
    status: opts.status ?? "sent",
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  });
}

async function countSends(userId: string): Promise<number> {
  const rows = await db
    .select({ id: emailSends.id })
    .from(emailSends)
    .where(eq(emailSends.userId, userId));
  return rows.length;
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

describe("meta.suppress — send-time enforcement", () => {
  it("re-enrollment inside the window is skipped journey_suppressed (no 2nd row, run still completes)", async () => {
    const userId = newUser();
    const journey = makeSuppressJourney({
      journeyId: `${RUN}-j1`,
      event: `${RUN}-e1`,
      suppress: hours(4),
    });
    registerJourneys(journey);
    const fn = grabFn();

    // DRIVE A — first enrollment sends.
    const a = (await fn(input(userId), makeCtx(`${RUN}-wfr-1a`))) as {
      status: string;
    };
    expect(a.status).toBe("completed");
    expect(providerSends).toHaveLength(1);
    expect(await countSends(userId)).toBe(1);

    // DRIVE B — fresh enrollment (A completed), same user, inside the 4h gap:
    // the send is suppressed. No provider call, no 2nd row — but the run STILL
    // completes (a suppressed send must not fail the journey).
    const b = (await fn(input(userId), makeCtx(`${RUN}-wfr-1b`))) as {
      status: string;
    };
    expect(b.status).toBe("completed");
    expect(providerSends).toHaveLength(1);
    expect(await countSends(userId)).toBe(1);
  });

  it("a prior send older than the window does NOT suppress", async () => {
    const userId = newUser();
    const email = `${userId}@example.com`;
    const journeyId = `${RUN}-j2`;

    // A completed prior enrollment with a send 5h ago — outside the 4h window.
    const priorState = await seedCompletedEnrollment({
      journeyId,
      userId,
      email,
    });
    await seedSend({
      userId,
      email,
      journeyStateId: priorState,
      createdAt: new Date(Date.now() - 5 * 60 * 60_000),
    });

    const journey = makeSuppressJourney({
      journeyId,
      event: `${RUN}-e2`,
      suppress: hours(4),
    });
    registerJourneys(journey);
    const fn = grabFn();

    const r = (await fn(input(userId), makeCtx(`${RUN}-wfr-2`))) as {
      status: string;
    };
    expect(r.status).toBe("completed");
    // The 5h-old row is outside the window → the new send is ALLOWED.
    expect(providerSends).toHaveLength(1);
  });

  it("a zero suppress duration disables the guard (both enrollments send)", async () => {
    const userId = newUser();
    const journey = makeSuppressJourney({
      journeyId: `${RUN}-j3`,
      event: `${RUN}-e3`,
      suppress: days(0),
    });
    registerJourneys(journey);
    const fn = grabFn();

    await fn(input(userId), makeCtx(`${RUN}-wfr-3a`));
    await fn(input(userId), makeCtx(`${RUN}-wfr-3b`));

    // suppressMs === 0 → guard inert → both sends go out.
    expect(providerSends).toHaveLength(2);
    expect(await countSends(userId)).toBe(2);
  });

  it("suppress is per-JOURNEY: a recent send from journey X does not suppress journey Y", async () => {
    const userId = newUser();

    const journeyX = makeSuppressJourney({
      journeyId: `${RUN}-jx`,
      event: `${RUN}-ex`,
      suppress: hours(4),
    });
    const fnX = grabFn();
    const journeyY = makeSuppressJourney({
      journeyId: `${RUN}-jy`,
      event: `${RUN}-ey`,
      suppress: hours(4),
    });
    const fnY = grabFn();
    registerJourneys(journeyX, journeyY);

    // Journey X sends to the user.
    await fnX(input(userId), makeCtx(`${RUN}-wfr-x`));
    expect(providerSends).toHaveLength(1);

    // Journey Y (different journeyId) to the SAME user is NOT suppressed — the
    // recent row belongs to X's enrollment, and the join filters by journey_id.
    const y = (await fnY(input(userId), makeCtx(`${RUN}-wfr-y`))) as {
      status: string;
    };
    expect(y.status).toBe("completed");
    expect(providerSends).toHaveLength(2);
  });

  it("a non-journey send (no boundary) is unaffected even when a journey's recent row exists", async () => {
    const userId = newUser();
    const email = `${userId}@example.com`;

    const journey = makeSuppressJourney({
      journeyId: `${RUN}-j5`,
      event: `${RUN}-e5`,
      suppress: hours(4),
    });
    registerJourneys(journey);
    const fn = grabFn();

    // A journey send lands a recent row for this recipient.
    await fn(input(userId), makeCtx(`${RUN}-wfr-5`));
    expect(providerSends).toHaveLength(1);

    // A direct `sendEmail` OUTSIDE any journey run (no JourneyBoundary) is a
    // transactional send — the suppress guard is inert, so it goes out normally.
    await sendEmail({
      to: email,
      userId,
      template: "welcome",
      subject: "Transactional",
      props: { name: "Ada" },
    });
    expect(providerSends).toHaveLength(2);
  });

  it("replay stability: the recorded verdict short-circuits even after the blocking row is deleted", async () => {
    const userId = newUser();
    const journey = makeSuppressJourney({
      journeyId: `${RUN}-j6`,
      event: `${RUN}-e6`,
      suppress: hours(4),
    });
    registerJourneys(journey);
    const fn = grabFn();
    const runB = `${RUN}-wfr-6b`;

    // DRIVE A — lands the blocking row.
    await fn(input(userId), makeCtx(`${RUN}-wfr-6a`));
    expect(providerSends).toHaveLength(1);

    // DRIVE B — fresh enrollment, suppressed: records { suppressed: true }.
    await fn(input(userId), makeCtx(runB));
    expect(providerSends).toHaveLength(1);

    // Delete the ONLY blocking email_sends row (drive A's). A LIVE re-check would
    // now find nothing and ALLOW the send — proving the replay uses the RECORD.
    await db.delete(emailSends).where(eq(emailSends.userId, userId));

    // RE-DRIVE B (same run id, replay-from-top): recovers enrollment B, and the
    // recorded verdict short-circuits the suppress check → still skipped.
    await fn(input(userId), makeCtx(runB));
    expect(providerSends).toHaveLength(1);
    // No send row was written by either B drive.
    expect(await countSends(userId)).toBe(0);
  });

  it("a prior failed send inside the window does NOT suppress", async () => {
    const userId = newUser();
    const email = `${userId}@example.com`;
    const journeyId = `${RUN}-j7`;

    const priorState = await seedCompletedEnrollment({
      journeyId,
      userId,
      email,
    });
    // A failed row (never dispatched) inside the window — excluded from the check.
    await seedSend({
      userId,
      email,
      journeyStateId: priorState,
      status: "failed",
    });

    const journey = makeSuppressJourney({
      journeyId,
      event: `${RUN}-e7`,
      suppress: hours(4),
    });
    registerJourneys(journey);
    const fn = grabFn();

    await fn(input(userId), makeCtx(`${RUN}-wfr-7`));
    // The failed row does not count → the new send is ALLOWED.
    expect(providerSends).toHaveLength(1);
  });
});
