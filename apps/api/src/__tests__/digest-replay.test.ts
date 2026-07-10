/**
 * REAL-Postgres replay proof for `ctx.digest` + the Part-A enrollment-insert
 * race hardening.
 *
 * The unit-stub suite (`digest.test.ts`) exercises the digest control flow
 * against a hand-rolled db mock; THIS suite drives the REAL `defineJourney`
 * durable-task `fn` against the Docker Postgres on :5434 — real
 * `createTrackedMailer`, a counting `vi.fn` provider, real `recordOnce`
 * jsonb-merge writes, real `ingestEvent`, and the real `uq_user_journey_active`
 * partial unique index. Only the Hatchet client is mocked (to capture `fn` and
 * to spy `events.push`), so a replay-from-top is modeled by invoking the SAME
 * `fn` twice with the SAME `workflowRunId` — exactly as an eviction-capable
 * engine does.
 *
 * It pins the FM-1/FM-2 digest invariants (window absorption, verbatim
 * replay-after-flush, auto-key site, eviction-resume) and the Part-A fix (the
 * 42P10 arbiter gotcha against the real index; a burst loser folds into an
 * `already_active` skip rather than a raw 23505 escaping `fn`).
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can drive it
// directly (mirrors journey-enrollment-replay.test.ts). The holder is `mock`-
// prefixed so vitest allows the hoisted mock factory to close over it.
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
  ingestEvent,
  insertEnrollment,
  minutes,
  sendEmail,
  setEmailService,
  setJourneyRegistry,
} = await import("@hogsend/engine");
type EmailProvider = import("@hogsend/engine").EmailProvider;
type DigestResult = import("@hogsend/core").DigestResult;
type DurationObject = import("@hogsend/core").DurationObject;
const { JourneyRegistry } = await import("@hogsend/core/registry");
const { templates } = await import("../emails/index.js");

const container = createHogsendClient();
const { db, logger } = container;

const RUN = `digrep-${Date.now()}`;
// Every user id we create, so afterAll can purge without a LIKE sweep.
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

// A journey that digests its trigger event over `window`, then sends ONE email
// tagged with the digest count. `captureInto` (when passed) records each
// `ctx.digest` return value so a test can assert verbatim-equality across a
// replay. entryLimit "unlimited" so a fresh run id is a legitimate re-enrollment.
function makeDigestJourney(opts: {
  journeyId: string;
  event: string;
  window: DurationObject;
  captureInto?: DigestResult[];
}) {
  return defineJourney({
    meta: {
      id: opts.journeyId,
      name: "Digest replay test",
      enabled: true,
      trigger: { event: opts.event },
      entryLimit: "unlimited",
      suppress: { hours: 0 },
    },
    run: async (user, ctx) => {
      const result = await ctx.digest({ window: opts.window });
      opts.captureInto?.push(result);
      await sendEmail({
        to: user.email,
        userId: user.id,
        journeyStateId: user.stateId,
        template: "welcome",
        subject: "Digest",
        props: { name: "Ada", count: result.count },
      });
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
// re-drive recovers the same enrollment. `onSleep` lets a test insert a
// mid-window event; it fires only on the FIRST sleep so a re-drive (which
// re-issues the identical constant-window sleep) doesn't double-insert.
function makeCtx(
  runId: string,
  onSleep?: () => Promise<void>,
): Record<string, unknown> {
  let slept = false;
  return {
    workflowRunId: () => runId,
    sleepFor: async () => {
      if (onSleep && !slept) {
        slept = true;
        await onSleep();
      }
    },
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

async function seedEvent(opts: {
  userId: string;
  event: string;
  occurredAt: Date;
  properties: Record<string, unknown>;
}) {
  await db.insert(userEvents).values({
    userId: opts.userId,
    event: opts.event,
    properties: opts.properties,
    source: "api",
    occurredAt: opts.occurredAt,
  });
}

async function readDigest(
  userId: string,
  nodeId: string,
): Promise<{ deadline?: string; result?: DigestResult }> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.userId, userId));
  const bag = (row?.context?.__digest__ ?? {}) as Record<string, unknown>;
  return {
    deadline: bag[`${nodeId}:deadline`] as string | undefined,
    result: bag[`${nodeId}:result`] as DigestResult | undefined,
  };
}

beforeEach(() => {
  installRealMailer();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  // email_sends → journey_states is a plain FK (no cascade), so purge sends
  // first; journey_states cascades journey_logs, contacts cascades aliases.
  await db.delete(emailSends).where(inArray(emailSends.userId, createdUsers));
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
  await db.delete(contacts).where(inArray(contacts.externalId, createdUsers));
});

describe("ctx.digest — real-DB replay + enrollment race", () => {
  it("window absorbs 3 events → 1 execution → 1 send (count=3, chronological)", async () => {
    const userId = newUser();
    const event = `${RUN}-e1`;
    const nodeId = `digest:${event}`;
    const base = Date.now();
    // Two events already in the window (the enrolling event + one more), both
    // inside the 15m default lookback.
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 5 * 60_000),
      properties: { projectId: "a" },
    });
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 2 * 60_000),
      properties: { projectId: "b" },
    });

    const journey = makeDigestJourney({
      journeyId: `${RUN}-j1`,
      event,
      window: minutes(10),
    });
    registerJourney(journey);
    const fn = grabFn();

    // A 3rd event arrives DURING the window (inserted from inside sleepFor).
    const ctx = makeCtx(`${RUN}-wfr-1`, () =>
      seedEvent({
        userId,
        event,
        occurredAt: new Date(),
        properties: { projectId: "c" },
      }),
    );

    await fn(input(userId), ctx);

    const { result } = await readDigest(userId, nodeId);
    expect(result?.count).toBe(3);
    expect(result?.truncated).toBe(false);
    expect(result?.events.map((e) => e.properties?.projectId)).toEqual([
      "a",
      "b",
      "c",
    ]);
    // Strictly ascending occurred_at.
    const times = (result?.events ?? []).map((e) =>
      new Date(e.occurredAt).getTime(),
    );
    expect(times[0]).toBeLessThan(times[1] ?? 0);
    expect(times[1]).toBeLessThan(times[2] ?? 0);
    // Exactly one execution flushed → exactly one send.
    expect(providerSends).toHaveLength(1);
  });

  it("replay after flush returns the digest VERBATIM — a backfilled in-window row does not appear, provider still called once", async () => {
    const userId = newUser();
    const event = `${RUN}-e2`;
    const nodeId = `digest:${event}`;
    const base = Date.now();
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 5 * 60_000),
      properties: { n: 1 },
    });
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 2 * 60_000),
      properties: { n: 2 },
    });

    const captured: DigestResult[] = [];
    const journey = makeDigestJourney({
      journeyId: `${RUN}-j2`,
      event,
      window: minutes(10),
      captureInto: captured,
    });
    registerJourney(journey);
    const fn = grabFn();
    const runId = `${RUN}-wfr-2`;

    // DRIVE 1 — flush records a 3-event result (2 seeded + 1 mid-window).
    await fn(
      input(userId),
      makeCtx(runId, () =>
        seedEvent({
          userId,
          event,
          occurredAt: new Date(),
          properties: { n: 3 },
        }),
      ),
    );
    const afterDrive1 = await readDigest(userId, nodeId);
    expect(afterDrive1.result?.count).toBe(3);
    expect(providerSends).toHaveLength(1);

    // Backfill a row whose occurred_at sits INSIDE the now-closed window. A
    // rescan would pick it up; the verbatim recordOnce read-first must NOT.
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 60_000),
      properties: { n: 99 },
    });

    // Model an eviction-engine replay-from-top that lands AFTER the flush recorded
    // the result but BEFORE the terminal "completed" write commits — the row's
    // state at that replay is non-terminal. Reset it to "active": the journal-
    // stable design (no peek fast path) re-issues the sleep + status flips, which
    // requires a non-terminal row (a genuinely completed run is terminal and a
    // replay correctly aborts via performSleep's 0-rows JourneyExitedError).
    await db
      .update(journeyStates)
      .set({ status: "active", completedAt: null })
      .where(eq(journeyStates.userId, userId));

    // DRIVE 2 — same run id: recovery-first, then the flush recordOnce READ-FIRST
    // returns the recorded result verbatim WITHOUT re-scanning (the backfill row
    // never appears).
    await fn(input(userId), makeCtx(runId));

    // The digest RETURN VALUE is byte-identical across the replay.
    expect(captured).toHaveLength(2);
    expect(captured[1]).toEqual(captured[0]);
    // The recorded result is unchanged (backfill absent), no rescan effect.
    const afterDrive2 = await readDigest(userId, nodeId);
    expect(afterDrive2.result).toEqual(afterDrive1.result);
    expect(afterDrive2.result?.count).toBe(3);
    // Send short-circuited on its idempotency key — still exactly one provider call.
    expect(providerSends).toHaveLength(1);
  });

  it("auto-keys the post-digest send at the digest site (journeySend:<runId>:digest:<E>:<template>)", async () => {
    const userId = newUser();
    const event = `${RUN}-e3`;
    const runId = `${RUN}-wfr-3`;
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(Date.now() - 60_000),
      properties: { k: 1 },
    });

    const journey = makeDigestJourney({
      journeyId: `${RUN}-j3`,
      event,
      window: minutes(10),
    });
    registerJourney(journey);
    const fn = grabFn();

    await fn(input(userId), makeCtx(runId));

    const [send] = await db
      .select({ key: emailSends.idempotencyKey })
      .from(emailSends)
      .where(eq(emailSends.userId, userId));
    expect(send?.key).toBe(`journeySend:${runId}:digest:${event}:welcome`);
  });

  it("absorption contract: an active enrollment stores an incoming event via ingest AND a new dispatch is skipped already_active", async () => {
    const userId = newUser();
    const event = `${RUN}-e4`;
    const journeyId = `${RUN}-j4`;
    const journey = makeDigestJourney({
      journeyId,
      event,
      window: minutes(10),
    });
    const registry = registerJourney(journey);
    const fn = grabFn();

    // Park an enrollment "waiting" (the digest's mid-window state) for this user.
    await db.insert(journeyStates).values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      currentNodeId: `digest:${event}`,
      status: "waiting",
      context: {},
      hatchetRunId: `${RUN}-wfr-4a`,
    });

    // FACT 1 — an event for a user with a live enrollment is STORED (absorbed
    // into user_events, whence the flush scan will collect it). Only
    // `hatchet.events.push` is stubbed (the mocked engine hatchet); ingest runs
    // for real.
    const ingested = await ingestEvent({
      db,
      registry,
      hatchet: container.hatchet,
      logger,
      event: {
        event,
        userId,
        userEmail: `${userId}@example.com`,
        eventProperties: { projectId: "z" },
        source: "api",
      },
    });
    expect(ingested.stored).toBe(true);
    const rows = await db
      .select({ id: userEvents.id })
      .from(userEvents)
      .where(eq(userEvents.userId, userId));
    expect(rows).toHaveLength(1);

    // FACT 2 — a DISTINCT dispatch (new run id) for the same user does NOT enroll
    // again: the active-state guard folds it to an already_active skip. This is
    // why the burst's 2nd..Nth events spawn no new run and are absorbed instead.
    const result = (await fn(input(userId), makeCtx(`${RUN}-wfr-4b`))) as {
      status: string;
      reason?: string;
    };
    expect(result).toMatchObject({
      status: "skipped",
      reason: "already_active",
    });
    // No second enrollment row was minted.
    const states = await db
      .select({ id: journeyStates.id })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(states).toHaveLength(1);
  });

  it("eviction mid-window then replay-from-top: reuses the stored deadline, flushes once, sends once", async () => {
    const userId = newUser();
    const event = `${RUN}-e5`;
    const nodeId = `digest:${event}`;
    const base = Date.now();
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 5 * 60_000),
      properties: { n: 1 },
    });
    await seedEvent({
      userId,
      event,
      occurredAt: new Date(base - 2 * 60_000),
      properties: { n: 2 },
    });

    const journey = makeDigestJourney({
      journeyId: `${RUN}-j5`,
      event,
      window: minutes(10),
    });
    registerJourney(journey);
    const fn = grabFn();
    const runId = `${RUN}-wfr-5`;

    // DRIVE 1 — model an eviction at the digest sleep: `sleepFor` never resolves
    // (worker torn down mid-flight). A latch fired at the sleep call gives a
    // deterministic sync point: by then the deadline is recorded and the row is
    // parked "waiting".
    let sleepReached: () => void = () => {};
    const sleepGate = new Promise<void>((res) => {
      sleepReached = res;
    });
    let drive1SleepArg: unknown;
    const evictCtx = {
      workflowRunId: () => runId,
      sleepFor: (arg: unknown) => {
        drive1SleepArg = arg;
        sleepReached();
        return new Promise<void>(() => {}); // never resolves == evicted
      },
      waitFor: () => new Promise(() => {}),
      now: async () => new Date(),
    };
    void fn(input(userId), evictCtx);
    await sleepGate;

    const parked = await readDigest(userId, nodeId);
    expect(parked.deadline).toBeTruthy();
    expect(parked.result).toBeUndefined();
    const [mid] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(mid?.status).toBe("waiting");
    expect(providerSends).toHaveLength(0);

    // DRIVE 2 — replay-from-top, same run id, sleep now elapses instantly. The
    // journal is POSITIONAL: the re-issued sleep must carry the IDENTICAL arg
    // (the constant window, not a remainder) or the determinism checker kills it.
    let drive2SleepArg: unknown;
    const resumeCtx = {
      workflowRunId: () => runId,
      sleepFor: async (arg: unknown) => {
        drive2SleepArg = arg;
      },
      waitFor: async () => ({}),
      now: async () => new Date(),
    };
    const result = (await fn(input(userId), resumeCtx)) as {
      status: string;
    };
    expect(result.status).toBe("completed");

    const resumed = await readDigest(userId, nodeId);
    // The deadline was reused verbatim (read-first / set-once), not re-armed.
    expect(resumed.deadline).toBe(parked.deadline);
    // The sleep arg is byte-identical across both drives (constant window).
    expect(drive1SleepArg).toMatch(/^\d+s$/);
    expect(drive2SleepArg).toBe(drive1SleepArg);
    expect(resumed.result?.count).toBe(2);
    expect(providerSends).toHaveLength(1);
    const [final] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(final?.status).toBe("completed");
  });

  it("insertEnrollment tolerates the partial-index race (42P10 arbiter) and re-inserts once the prior row is terminal", async () => {
    const userId = newUser();
    const journeyId = `${RUN}-j6`;

    // First insert wins the live slot.
    const first = await insertEnrollment({
      db,
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      context: {},
      hatchetRunId: `${RUN}-wfr-6a`,
    });
    expect(first?.id).toBeTruthy();

    // Second insert for the SAME (user, journey) races the partial unique index.
    // A wrong arbiter predicate would throw 42P10; onConflictDoNothing must
    // instead return undefined (0 rows) — the burst-loser fold.
    const second = await insertEnrollment({
      db,
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      context: {},
      hatchetRunId: `${RUN}-wfr-6b`,
    });
    expect(second).toBeUndefined();

    // Flip the first row terminal — it now sits OUTSIDE the partial index.
    await db
      .update(journeyStates)
      .set({ status: "completed", completedAt: new Date() })
      .where(eq(journeyStates.id, first?.id ?? ""));

    // A third insert succeeds: the index only covers active/waiting rows.
    const third = await insertEnrollment({
      db,
      userId,
      userEmail: `${userId}@example.com`,
      journeyId,
      context: {},
      hatchetRunId: `${RUN}-wfr-6c`,
    });
    expect(third?.id).toBeTruthy();
    expect(third?.id).not.toBe(first?.id);
  });
});
