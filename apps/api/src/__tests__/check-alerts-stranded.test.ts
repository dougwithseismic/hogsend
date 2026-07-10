import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// DB-touching test against the real docker TimescaleDB (mirrors
// bucket-reconcile.test.ts), overriding the vitest.config placeholder
// DATABASE_URL. `surfaceStrandedWaiting` is the exported test seam — invoked
// directly with a real db + a spy logger so we can assert what it flags.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createDatabase, journeyStates } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { surfaceStrandedWaiting } = await import("@hogsend/engine");

const { db } = createDatabase({ url: process.env.DATABASE_URL });

const RUN = `stranded-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const JOURNEY_ID = `${RUN}-journey`;
const uid = (label: string) => `${RUN}-${label}`;
const HOUR = 60 * 60 * 1000;

interface Finding {
  stateId: string;
  deadlineSource: string;
}

/** A minimal spy logger — surfaceStrandedWaiting only calls error/warn. */
function makeLogger() {
  return { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
}

/** Cast the spy to the winston `Logger` the detector expects (only error/warn used). */
type LoggerArg = Parameters<typeof surfaceStrandedWaiting>[0]["logger"];
const asLogger = (l: ReturnType<typeof makeLogger>): LoggerArg =>
  l as unknown as LoggerArg;

/**
 * Collect the findings the detector logged for a specific seeded stateId (the
 * single `logger.error` carries a `states` sample array; the DB is shared, so we
 * filter to our own row). Returns [] when the row was not flagged.
 */
function findingsFor(
  logger: ReturnType<typeof makeLogger>,
  stateId: string,
): Finding[] {
  const out: Finding[] = [];
  for (const call of logger.error.mock.calls) {
    if (call[0] !== "Stranded waiting journey states detected") continue;
    const states = (call[1]?.states ?? []) as Finding[];
    for (const s of states) if (s.stateId === stateId) out.push(s);
  }
  return out;
}

/**
 * Insert one journey_states row. A unique userId per row dodges the partial
 * active-enrollment unique index on (user_id, journey_id). Returns the row id.
 */
async function seedState(opts: {
  userId: string;
  status?: "active" | "waiting";
  waitDeadline?: Date | null;
  context?: Record<string, unknown>;
}): Promise<string> {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: opts.userId,
      userEmail: `${opts.userId}@example.com`,
      journeyId: JOURNEY_ID,
      currentNodeId: "daily-digest",
      status: opts.status ?? "waiting",
      waitDeadline: opts.waitDeadline ?? null,
      context: opts.context ?? {},
    })
    .returning({ id: journeyStates.id });
  if (!row) throw new Error("seedState insert returned no row");
  return row.id;
}

/** A digest context bag: `<label>:deadline` (+ optional `<label>:result`). */
function digestContext(
  label: string,
  deadline: Date,
  result?: unknown,
): Record<string, unknown> {
  const bag: Record<string, unknown> = {
    [`${label}:deadline`]: deadline.toISOString(),
  };
  if (result !== undefined) bag[`${label}:result`] = result;
  return { __digest__: bag };
}

let logger: ReturnType<typeof makeLogger>;

beforeEach(() => {
  logger = makeLogger();
});

afterAll(async () => {
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}-%`));
});

describe("surfaceStrandedWaiting", () => {
  it("flags a waiting row whose wait_deadline is 2h past due", async () => {
    const stateId = await seedState({
      userId: uid("col-overdue"),
      waitDeadline: new Date(Date.now() - 2 * HOUR),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    const found = findingsFor(logger, stateId);
    expect(found).toHaveLength(1);
    expect(found[0]?.deadlineSource).toBe("wait_deadline");
  });

  it("flags a waiting row with an overdue __digest__ deadline and NO result", async () => {
    const stateId = await seedState({
      userId: uid("digest-overdue"),
      context: digestContext("daily-digest", new Date(Date.now() - 2 * HOUR)),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    const found = findingsFor(logger, stateId);
    expect(found).toHaveLength(1);
    expect(found[0]?.deadlineSource).toBe("digest:daily-digest");
  });

  it("does NOT flag when the overdue digest deadline HAS a recorded result", async () => {
    // A recorded result means the digest flushed cleanly — the row may
    // legitimately be parked on a LATER primitive, so it is not stranded.
    const stateId = await seedState({
      userId: uid("digest-flushed"),
      context: digestContext("daily-digest", new Date(Date.now() - 2 * HOUR), {
        count: 0,
        events: [],
      }),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    expect(findingsFor(logger, stateId)).toHaveLength(0);
  });

  it("does NOT flag a waiting row with a future deadline", async () => {
    const stateId = await seedState({
      userId: uid("future"),
      waitDeadline: new Date(Date.now() + 2 * HOUR),
      context: digestContext("daily-digest", new Date(Date.now() + 2 * HOUR)),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    expect(findingsFor(logger, stateId)).toHaveLength(0);
  });

  it("never flags an active row (even with overdue deadlines)", async () => {
    // status='active' rows are outside the query's `status='waiting'` filter, so
    // an active row with a long-overdue deadline is never surfaced.
    const stateId = await seedState({
      userId: uid("active"),
      status: "active",
      waitDeadline: new Date(Date.now() - 5 * HOUR),
      context: digestContext("daily-digest", new Date(Date.now() - 5 * HOUR)),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    expect(findingsFor(logger, stateId)).toHaveLength(0);
  });

  it("does NOT flag a waiting row inside the 1h grace window", async () => {
    // Deadline only 20 min past — within the wake-latency + scheduleTimeout grace.
    const stateId = await seedState({
      userId: uid("within-grace"),
      waitDeadline: new Date(Date.now() - 20 * 60 * 1000),
    });

    await surfaceStrandedWaiting({ db, logger: asLogger(logger) });

    expect(findingsFor(logger, stateId)).toHaveLength(0);
  });
});
