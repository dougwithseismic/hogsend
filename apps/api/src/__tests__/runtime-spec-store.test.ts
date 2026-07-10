/**
 * Slice 2 P2 — the RuntimeSpecStore: an in-memory index of active DB specs that
 * ingest consults to dispatch/exit live-added journeys without a restart.
 *
 * DB: shared TimescaleDB on 5434; RUN-namespaced rows, cleaned in afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { journeySpecs } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { createHogsendClient, RuntimeSpecStore } = await import(
  "@hogsend/engine"
);

const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: async () => {} },
  runs: { cancel: () => {}, get: () => {} },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const { db, logger } = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});

const RUN = `rss-${Date.now()}`;

function spec(id: string, event: string) {
  return {
    specVersion: 1,
    id,
    meta: {
      name: id,
      enabled: true,
      trigger: { event },
      entryLimit: "unlimited",
      suppress: { minutes: 1 },
    },
    steps: [{ id: "note", type: "checkpoint" }],
  };
}

async function insert(id: string, event: string, enabled = true) {
  await db.insert(journeySpecs).values({
    journeyId: id,
    enabled,
    // biome-ignore lint/suspicious/noExplicitAny: raw jsonb under test
    spec: spec(id, event) as any,
  });
}

beforeEach(async () => {
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
});

afterAll(async () => {
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
});

describe("RuntimeSpecStore", () => {
  it("indexes enabled specs by id and by trigger event; excludes disabled", async () => {
    const a = `${RUN}-a`;
    const b = `${RUN}-b`;
    const off = `${RUN}-off`;
    await insert(a, `${RUN}.one`);
    await insert(b, `${RUN}.two`);
    await insert(off, `${RUN}.one`, false);

    const store = new RuntimeSpecStore();
    await store.refresh(db, 1000, logger);

    expect(store.getById(a)?.id).toBe(a);
    expect(store.getById(off)).toBeUndefined();
    const mine = store.all().filter((s) => s.id.startsWith(RUN));
    expect(mine).toHaveLength(2);

    const onOne = store
      .getByTriggerEvent(`${RUN}.one`)
      .filter((s) => s.id.startsWith(RUN));
    expect(onOne.map((s) => s.id)).toEqual([a]); // off excluded
    expect(store.getByTriggerEvent(`${RUN}.two`).map((s) => s.id)).toContain(b);
  });

  it("refreshIfStale reloads only after the TTL elapses", async () => {
    const a = `${RUN}-ttl-a`;
    await insert(a, `${RUN}.ttl`);

    const store = new RuntimeSpecStore();
    await store.refresh(db, 10_000, logger);
    const before = store.all().filter((s) => s.id.startsWith(RUN)).length;

    // Add another AFTER the last refresh.
    await insert(`${RUN}-ttl-b`, `${RUN}.ttl`);

    // Within TTL → no reload.
    await store.refreshIfStale(db, 12_000, 5000, logger);
    expect(store.all().filter((s) => s.id.startsWith(RUN)).length).toBe(before);

    // Past TTL → reload picks up the new row.
    await store.refreshIfStale(db, 16_000, 5000, logger);
    expect(store.all().filter((s) => s.id.startsWith(RUN)).length).toBe(
      before + 1,
    );
  });

  it("markStale forces the next refreshIfStale to reload", async () => {
    await insert(`${RUN}-ms-a`, `${RUN}.ms`);
    const store = new RuntimeSpecStore();
    await store.refresh(db, 10_000, logger);
    const before = store.all().filter((s) => s.id.startsWith(RUN)).length;

    await insert(`${RUN}-ms-b`, `${RUN}.ms`);
    store.markStale();
    // Even though only 1ms passed, markStale forces the reload.
    await store.refreshIfStale(db, 10_001, 5000, logger);
    expect(store.all().filter((s) => s.id.startsWith(RUN)).length).toBe(
      before + 1,
    );
  });
});
