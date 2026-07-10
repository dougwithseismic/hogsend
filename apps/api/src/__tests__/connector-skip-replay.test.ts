/**
 * THE LAW proof for the connector preference gate: the skip verdict is recorded
 * by the durable memo INSIDE the memoized closure, so a journey replay-from-top
 * re-issues byte-identical durable calls and replays the SAME verdict — even if
 * the recipient's preferences flip in the DB between the run and the replay.
 *
 * We model a Hatchet replay the way `journey-run-replay.test.ts` does: drive the
 * same `run` body twice, each time through a FRESH `JourneyBoundary` (new
 * `seenKeys`) pinned to the SAME `runAnchor`, sharing ONE memo journal across
 * both drives (so eviction short-circuits the replay). Real Postgres (:5434),
 * RUN-namespaced rows, full cleanup in afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import type { HogsendClient, JourneyBoundary } from "@hogsend/engine";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const { contacts, emailPreferences, connectorDeliveries } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const {
  buildListRegistry,
  createHogsendClient,
  createMemoize,
  defineConnectorAction,
  isConnectorActionSkipped,
  resetListRegistry,
  runWithJourneyBoundary,
  sendConnectorAction,
  synthesizeChannelLists,
} = await import("@hogsend/engine");

const runSpy = vi.fn();
const memberAction = defineConnectorAction<{ refs: string[] }, unknown>({
  connectorId: "fakeconn",
  name: "dm",
  audience: { kind: "member", ref: (args) => args.refs },
  run: async (args, ctx) => {
    runSpy(args, ctx);
    return { messageId: "m1", delivered: true };
  },
});

const container = createHogsendClient({
  connectorActions: [memberAction],
  overrides: { hatchet: mockHatchet },
});
const { db } = container;
buildListRegistry([], undefined, synthesizeChannelLists([memberAction]));

const RUN = `csr-${Date.now()}`;
const createdContactIds: string[] = [];
const createdPrefIds: string[] = [];

async function seedContact(
  values: Partial<typeof contacts.$inferInsert>,
): Promise<typeof contacts.$inferSelect> {
  const [row] = await db.insert(contacts).values(values).returning();
  if (!row) throw new Error("seedContact: insert returned no row");
  createdContactIds.push(row.id);
  return row;
}

async function seedPref(
  values: typeof emailPreferences.$inferInsert,
): Promise<string> {
  const [row] = await db
    .insert(emailPreferences)
    .values(values)
    .returning({ id: emailPreferences.id });
  if (!row) throw new Error("seedPref: insert returned no row");
  createdPrefIds.push(row.id);
  return row.id;
}

/**
 * A memo journal modeling a durable, eviction-capable Hatchet context: `memo`
 * records the first result per deps key and replays it verbatim on the next call
 * with the same deps. `memoDeps` records the deps sequence so a test can assert
 * the durable call ORDER is identical across drives. `tag` guards that `memo` is
 * invoked with its `this` binding intact (mirrors the SDK's `throwIfCancelled`).
 */
function makeJournalCtx() {
  const journal = new Map<string, unknown>();
  const memoDeps: string[] = [];
  const ctx = {
    supportsEviction: true,
    tag: "journal",
    async memo<T>(fn: () => Promise<T> | T, deps: unknown[]): Promise<T> {
      if (this.tag !== "journal") {
        throw new TypeError("memo called without its `this` binding");
      }
      const k = JSON.stringify(deps);
      memoDeps.push(k);
      if (journal.has(k)) return journal.get(k) as T;
      const v = await fn();
      journal.set(k, v);
      return v;
    },
  };
  return { ctx, memoDeps };
}

function boundaryFor(
  memoize: JourneyBoundary["memoize"],
  runAnchor: string,
): JourneyBoundary {
  return {
    stateId: runAnchor,
    runAnchor,
    currentLabel: undefined,
    seenKeys: new Set<string>(),
    seenRecordLabels: new Set<string>(),
    memoize,
  };
}

async function deliveryRowsForAnchor(
  anchor: string,
): Promise<Array<{ id: string; dedupeKey: string | null }>> {
  const rows = await db
    .select({
      id: connectorDeliveries.id,
      dedupeKey: connectorDeliveries.dedupeKey,
    })
    .from(connectorDeliveries)
    .where(eq(connectorDeliveries.connectorId, "fakeconn"));
  return rows.filter((r) => r.dedupeKey?.includes(anchor));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterAll(async () => {
  await db
    .delete(connectorDeliveries)
    .where(eq(connectorDeliveries.connectorId, "fakeconn"));
  if (createdPrefIds.length > 0) {
    await db
      .delete(emailPreferences)
      .where(inArray(emailPreferences.id, createdPrefIds));
  }
  if (createdContactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, createdContactIds));
  }
  resetListRegistry();
  await container.dbClient.end({ timeout: 5 }).catch(() => {});
});

describe("connector skip replay-safety (THE LAW)", () => {
  it("records a skip in the memo and replays it verbatim after prefs flip", async () => {
    const email = `${RUN}-t1@example.com`;
    const externalId = `${RUN}-t1`;
    await seedContact({ email, externalId });
    const prefId = await seedPref({
      userId: externalId,
      email,
      categories: { fakeconn: false },
    });

    const journal = makeJournalCtx();
    const memoize = createMemoize(journal.ctx);
    const anchor = `${RUN}-anchor-t1`;
    const drive = () =>
      runWithJourneyBoundary(boundaryFor(memoize, anchor), () =>
        sendConnectorAction({
          connectorId: "fakeconn",
          action: "dm",
          args: { refs: [email] },
        }),
      );

    const first = await drive();
    expect(isConnectorActionSkipped(first)).toBe(true);
    expect(first).toMatchObject({ reason: "channel_unsubscribed" });

    // FLIP the recipient to subscribed in the DB between run and replay.
    await db
      .update(emailPreferences)
      .set({ categories: { fakeconn: true } })
      .where(eq(emailPreferences.id, prefId));

    // REPLAY: the memo short-circuits, replaying the recorded skip verbatim —
    // the live-flipped preference is NEVER re-read.
    const second = await drive();
    expect(second).toEqual(first);
    expect(isConnectorActionSkipped(second)).toBe(true);

    // The action never ran on EITHER drive, and no ledger row was claimed.
    expect(runSpy).not.toHaveBeenCalled();
    expect(await deliveryRowsForAnchor(anchor)).toHaveLength(0);
  });

  it("a subscribed send runs once; the memo replay short-circuits (one invocation total)", async () => {
    const email = `${RUN}-t2@example.com`;
    const externalId = `${RUN}-t2`;
    await seedContact({ email, externalId });
    // No pref row → subscribed by default.

    const journal = makeJournalCtx();
    const memoize = createMemoize(journal.ctx);
    const anchor = `${RUN}-anchor-t2`;
    const drive = () =>
      runWithJourneyBoundary(boundaryFor(memoize, anchor), () =>
        sendConnectorAction({
          connectorId: "fakeconn",
          action: "dm",
          args: { refs: [email] },
        }),
      );

    const first = await drive();
    expect(isConnectorActionSkipped(first)).toBe(false);
    expect(first).toMatchObject({ messageId: "m1", delivered: true });

    const second = await drive();
    expect(second).toEqual(first);

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(await deliveryRowsForAnchor(anchor)).toHaveLength(1);
  });

  it("derives identical keys + durable-call order across drives (skip then send)", async () => {
    const blockedEmail = `${RUN}-t3blocked@example.com`;
    const blockedExt = `${RUN}-t3blocked`;
    await seedContact({ email: blockedEmail, externalId: blockedExt });
    await seedPref({
      userId: blockedExt,
      email: blockedEmail,
      categories: { fakeconn: false },
    });

    const okEmail = `${RUN}-t3ok@example.com`;
    const okExt = `${RUN}-t3ok`;
    await seedContact({ email: okEmail, externalId: okExt });

    const journal = makeJournalCtx();
    const memoize = createMemoize(journal.ctx);
    const anchor = `${RUN}-anchor-t3`;

    // Two sends in one run — a SKIP followed by a real SEND. Distinct
    // idempotencyLabels give them distinct sites (else both would derive the
    // same key and registerKey would throw).
    const drive = async (): Promise<string[]> => {
      const boundary = boundaryFor(memoize, anchor);
      await runWithJourneyBoundary(boundary, async () => {
        await sendConnectorAction({
          connectorId: "fakeconn",
          action: "dm",
          args: { refs: [blockedEmail] },
          idempotencyLabel: "first",
        });
        await sendConnectorAction({
          connectorId: "fakeconn",
          action: "dm",
          args: { refs: [okEmail] },
          idempotencyLabel: "second",
        });
      });
      return Array.from(boundary.seenKeys);
    };

    const keys1 = await drive();
    const keys2 = await drive();

    // The two sends registered exactly two keys, in the SAME order both drives.
    expect(keys1).toHaveLength(2);
    expect(keys2).toEqual(keys1);
    // The durable memo saw the SAME deps in the SAME order across both drives.
    expect(journal.memoDeps.slice(2, 4)).toEqual(journal.memoDeps.slice(0, 2));
    // Exactly one real send total (the okEmail branch, drive 1 only).
    expect(runSpy).toHaveBeenCalledTimes(1);
  });

  it("Layer-2 only (no eviction): a replay dedupes via connector_deliveries", async () => {
    const email = `${RUN}-t4@example.com`;
    const externalId = `${RUN}-t4`;
    await seedContact({ email, externalId });
    // Subscribed by default.

    // No memo journal — a pre-eviction engine. `memoize` falls through to fn()
    // on BOTH drives, so exactly-once rests entirely on the Layer-2 DB backstop.
    const memoize = createMemoize({});
    const anchor = `${RUN}-anchor-t4`;
    const drive = () =>
      runWithJourneyBoundary(boundaryFor(memoize, anchor), () =>
        sendConnectorAction({
          connectorId: "fakeconn",
          action: "dm",
          args: { refs: [email] },
        }),
      );

    const first = await drive();
    const second = await drive();
    expect(first).toMatchObject({ messageId: "m1", delivered: true });
    expect(second).toEqual(first);

    // The closure re-ran on drive 2 (no memo), but the connector_deliveries
    // short-circuit returned the stored result WITHOUT re-invoking the action.
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(await deliveryRowsForAnchor(anchor)).toHaveLength(1);
  });
});
