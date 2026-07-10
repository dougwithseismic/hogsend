/**
 * REAL-Postgres proof that a graceful worker-shutdown ABORT of an in-flight
 * durable journey run is treated as a RELEASE for re-dispatch — NOT a failure.
 *
 * A SIGTERM → `createWorker`'s handler → `worker.stop()` aborts suspended
 * durable runs so Hatchet can REASSIGN them; the suspended `sleepFor`/`waitFor`
 * rejects with the SDK's AbortError. Before the fix, `define-journey`'s catch
 * wrote the row `failed` + pushed `journey:failed`, permanently poisoning the
 * enrollment (recovery-first later found a terminal row and never resumed) —
 * turning every graceful Railway redeploy mid-wait into enrollment death.
 *
 * This drives the REAL `defineJourney` durable-task `fn` against the Docker
 * Postgres on :5434 (mirroring `digest-replay.test.ts`); only the Hatchet client
 * is mocked (to capture `fn` and spy `events.push`). A digest journey is used
 * (no email send → no mailer needed) because it maximizes the exposure: the
 * abort lands in the digest window sleep, and a re-dispatch on the SAME run id
 * must resume via the recorded deadline and complete.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { randomUUID } from "node:crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Capture the durable-task `fn` passed to `defineJourney` so we can drive it
// directly. `mock`-prefixed so the hoisted mock factory may close over it.
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

const { journeyStates, userEvents } = await import("@hogsend/db");
const { eq, inArray } = await import("drizzle-orm");
const { createHogsendClient, defineJourney, minutes, setJourneyRegistry } =
  await import("@hogsend/engine");
const { JourneyRegistry } = await import("@hogsend/core/registry");

const container = createHogsendClient();
const { db } = container;
// `createHogsendClient` defaults `hatchet` to the mocked module singleton
// (`overrides?.hatchet ?? hatchet`) — the SAME object `define-journey` pushes
// journey:failed/completed on. Reading it via the container avoids a deep
// `import` of the engine source, which would drag it under the api `rootDir`.
const engineHatchet = container.hatchet;

const RUN = `abort-${Date.now()}`;
const createdUsers: string[] = [];
function newUser(): string {
  const id = randomUUID();
  createdUsers.push(id);
  return id;
}

/** Mirrors the SDK's abort-error CONTRACT (name + code) without depending on the
 * message text (which the fix deliberately never matches on). */
class ShutdownAbortError extends Error {
  code = "ABORT_ERR";
  constructor(message: string) {
    super(message);
    this.name = "AbortError";
  }
}

function grabFn(): CapturedFn {
  const fn = mockFnHolder.fn;
  if (!fn) throw new Error("durable fn was not captured");
  return fn;
}

function input(userId: string) {
  return { userId, userEmail: `${userId}@example.com`, properties: {} };
}

// A digest journey that does NOT send (no mailer needed). `entryLimit`
// "unlimited" so a fresh run id would be a legitimate re-enrollment; a SAME run
// id is a replay recovered by hatchetRunId.
function makeSleepingDigestJourney(journeyId: string, event: string) {
  const journey = defineJourney({
    meta: {
      id: journeyId,
      name: "Shutdown-abort test",
      enabled: true,
      trigger: { event },
      entryLimit: "unlimited",
      suppress: { hours: 0 },
    },
    run: async (_user, ctx) => {
      await ctx.digest({ window: minutes(10) });
    },
  });
  const registry = new JourneyRegistry();
  registry.register(journey.meta);
  setJourneyRegistry(registry);
  return journey;
}

function ctxWith(runId: string, sleepFor: () => Promise<void>) {
  return {
    workflowRunId: () => runId,
    sleepFor,
    waitFor: async () => ({}),
    now: async () => new Date(),
  };
}

function pushCalls(): unknown[][] {
  return (
    engineHatchet.events.push as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls;
}

const abortSleep = async () => {
  throw new ShutdownAbortError("Operation cancelled by AbortSignal");
};
const resolvingSleep = async () => {};

beforeEach(() => {
  (
    engineHatchet.events.push as unknown as { mockClear: () => void }
  ).mockClear();
});

afterAll(async () => {
  if (createdUsers.length === 0) return;
  await db
    .delete(journeyStates)
    .where(inArray(journeyStates.userId, createdUsers));
  await db.delete(userEvents).where(inArray(userEvents.userId, createdUsers));
});

describe("graceful worker shutdown — abort is a release, not a failure", () => {
  it("leaves the enrollment 'waiting' (not failed), errorMessage null, and pushes no journey:failed", async () => {
    const userId = newUser();
    makeSleepingDigestJourney(`${RUN}-j1`, `${RUN}-e1`);
    const fn = grabFn();

    // The abort must RETHROW so the SDK completes its cancellation flow.
    await expect(
      fn(input(userId), ctxWith(`${RUN}-wfr-1`, abortSleep)),
    ).rejects.toBeInstanceOf(ShutdownAbortError);

    const [row] = await db
      .select({
        status: journeyStates.status,
        errorMessage: journeyStates.errorMessage,
      })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    // Left intact for re-dispatch — NOT flipped to failed.
    expect(row?.status).toBe("waiting");
    expect(row?.errorMessage).toBeNull();
    // No spurious failure event.
    expect(pushCalls().some((c) => c[0] === "journey:failed")).toBe(false);
  });

  it("release then re-dispatch on the same runId → recovery-first resumes and completes", async () => {
    const userId = newUser();
    const runId = `${RUN}-wfr-2`;
    makeSleepingDigestJourney(`${RUN}-j2`, `${RUN}-e2`);
    const fn = grabFn();

    // DRIVE 1 — graceful shutdown aborts mid-window.
    await expect(
      fn(input(userId), ctxWith(runId, abortSleep)),
    ).rejects.toBeInstanceOf(ShutdownAbortError);
    const [mid] = await db
      .select({ status: journeyStates.status })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(mid?.status).toBe("waiting");

    // DRIVE 2 — Hatchet re-dispatches the SAME run id; the sleep now elapses.
    // recovery-first reuses the enrollment (bypassing entry guards), the recorded
    // digest deadline resumes the remaining window, and the run completes.
    const result = (await fn(
      input(userId),
      ctxWith(runId, resolvingSleep),
    )) as { status: string };
    expect(result.status).toBe("completed");

    const [final] = await db
      .select({
        status: journeyStates.status,
        errorMessage: journeyStates.errorMessage,
      })
      .from(journeyStates)
      .where(eq(journeyStates.userId, userId));
    expect(final?.status).toBe("completed");
    expect(final?.errorMessage).toBeNull();
  });
});
