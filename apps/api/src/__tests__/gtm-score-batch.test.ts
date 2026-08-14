import { afterAll, expect, it, vi } from "vitest";

// DB-touching test. The DEFAULT below is the repo-wide one every file in this
// directory shares, and it is what CI's service container listens on. Point a
// worktree at its own stack by exporting HOGSEND_TEST_DATABASE_URL — never by
// editing the default (DECISIONS §4b).
process.env.DATABASE_URL =
  process.env.HOGSEND_TEST_DATABASE_URL ??
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// `gtm-score.ts` defines a Hatchet task at module load; the client is mocked so
// importing it needs no gRPC engine. Nothing here runs the task itself — only
// `selectScoreBatch`, against a real Postgres.
const hatchetMock = () => ({
  hatchet: {
    durableTask: vi.fn((config: Record<string, unknown>) => ({ ...config })),
    task: vi.fn((config: Record<string, unknown>) => ({ ...config })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", () => hatchetMock());
vi.mock("../lib/hatchet.js", () => hatchetMock());

const { contacts, createDatabase, userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { computeGtmScore, selectScoreBatch } = await import(
  "../workflows/gtm-score.js"
);

const { db, client } = createDatabase({ url: process.env.DATABASE_URL ?? "" });

const RUN = `gtmb-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

/** One clock instant for the whole file, mirroring the task's own boundary read. */
const NOW = new Date();
const WINDOW_START = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
const daysAgo = (n: number) =>
  new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000);

async function seed(
  label: string,
  properties: Record<string, unknown>,
  events: Array<{ event: string; daysAgo: number }>,
): Promise<{ userId: string; contactId: string }> {
  const userId = `${RUN}-${label}`;
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: userId,
      email: `${userId}@acme-gtm.test`,
      properties,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("seed: insert returned no row");

  if (events.length > 0) {
    await db.insert(userEvents).values(
      events.map((e) => ({
        userId,
        event: e.event,
        properties: {},
        occurredAt: daysAgo(e.daysAgo),
      })),
    );
  }
  return { userId, contactId: row.id };
}

/** Pull one contact's row out of a full keyset walk of the batch query. */
async function rowFor(contactId: string) {
  let cursor = ZERO_UUID;
  for (;;) {
    const page = await selectScoreBatch(db, {
      limit: 500,
      cursor,
      now: NOW,
      windowStart: WINDOW_START,
    });
    if (page.length === 0) return undefined;
    const hit = page.find((r) => r.id === contactId);
    if (hit) return hit;
    cursor = page[page.length - 1]?.id ?? cursor;
  }
}

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
  await client.end({ timeout: 5 });
});

// ---------------------------------------------------------------------------
// The SQL is where the subtle mistakes live. These drive the REAL query.
// ---------------------------------------------------------------------------

it("counts each behaviour event independently, within the window", async () => {
  const { contactId } = await seed("counts", {}, [
    { event: "key.action", daysAgo: 1 },
    { event: "key.action", daysAgo: 2 },
    { event: "key.action", daysAgo: 40 }, // outside the 30-day window
    { event: "feature.used", daysAgo: 3 },
    { event: "paid_feature.attempted", daysAgo: 4 },
    { event: "email.link_clicked", daysAgo: 5 },
    { event: "some.unrelated", daysAgo: 1 }, // counted by nothing
  ]);

  const row = await rowFor(contactId);

  expect(row?.key_actions).toBe(2); // the 40-day-old one is excluded
  expect(row?.feature_uses).toBe(1);
  expect(row?.paid_feature_attempts).toBe(1);
  expect(row?.email_link_clicks).toBe(1);
});

it("a contact with no events reports null recency, which decays behaviour to zero", async () => {
  const { contactId } = await seed("silent", { seniority: "vp" }, []);

  const row = await rowFor(contactId);

  expect(row?.key_actions).toBe(0);
  expect(row?.days_since_last_activity).toBeNull();

  // Fit still counts — only the behaviour half decays.
  expect(
    computeGtmScore({
      refinedSeniority: row?.properties?.seniority,
      keyActions: row?.key_actions ?? 0,
      featureUses: row?.feature_uses ?? 0,
      paidFeatureAttempts: row?.paid_feature_attempts ?? 0,
      emailLinkClicks: row?.email_link_clicks ?? 0,
      daysSinceLastActivity: row?.days_since_last_activity ?? null,
    }),
  ).toBe(20);
});

// ---------------------------------------------------------------------------
// THE FEEDBACK LOOP. `gtm.scored` is written BY this job. If the recency metric
// counted it, every scored contact would look active as of its own last scoring,
// resetting decay to 1.0 on the next run and inflating a score that never moved.
// A metric that feeds a computation whose output resets that metric never settles.
// ---------------------------------------------------------------------------

it("recency IGNORES the gtm.scored row this job writes", async () => {
  const { contactId } = await seed("feedback", {}, [
    { event: "key.action", daysAgo: 20 }, // real activity: 20d → decay 0.5
    { event: "gtm.scored", daysAgo: 0 }, // the job's own write, from last night
  ]);

  const row = await rowFor(contactId);

  // ~20, not ~0. Remove the FILTER on the MAX and this collapses to ~0.
  expect(row?.days_since_last_activity).toBeGreaterThan(19);
  expect(row?.days_since_last_activity).toBeLessThan(21);

  // And `gtm.scored` contributes to no behaviour count either.
  expect(row?.key_actions).toBe(1);
  expect(row?.feature_uses).toBe(0);
});

/**
 * A WHOLE-DATABASE budget, not the suite default.
 *
 * This case walks the ENTIRE contacts table one row at a time (`limit: 1`), so
 * its cost is one query per contact in the shared dev database — not per
 * contact this file seeded. The suite creates contacts it never deletes, so
 * that number only grows: measured 6.7s running this file alone and 19.9s
 * under a full parallel suite, against vitest's 30s default.
 *
 * It therefore fails intermittently with a TIMEOUT, in a file no diff in
 * flight has touched — which reads exactly like a regression in whatever is
 * being reviewed at the time, and is not one. (It cost two misattributions in
 * one session.) 90s is ~4.5x the measured loaded cost, matching the budget
 * PRD 18 T1 shipped for the same shape.
 *
 * The DURABLE fix is to stop the walk being whole-database — a scope argument
 * on `selectScoreBatch`, or truncating the dev database periodically. This
 * budget buys headroom; it does not stop the growth.
 */
it("the keyset cursor advances and terminates", {
  timeout: 90_000,
}, async () => {
  await seed("cursor-a", {}, []);
  await seed("cursor-b", {}, []);

  // Walk the whole table one row at a time; it must terminate and never repeat.
  let cursor = ZERO_UUID;
  const seen = new Set<string>();
  let pages = 0;
  for (;;) {
    const page = await selectScoreBatch(db, {
      limit: 1,
      cursor,
      now: NOW,
      windowStart: WINDOW_START,
    });
    if (page.length === 0) break;
    for (const r of page) {
      // A repeated id means the cursor is not advancing — the infinite-loop bug.
      expect(seen.has(r.id)).toBe(false);
      seen.add(r.id);
    }
    cursor = page[page.length - 1]?.id ?? cursor;
    pages += 1;
    if (pages > 5000) throw new Error("keyset walk did not terminate");
  }

  expect(seen.size).toBeGreaterThanOrEqual(2);
});
