/**
 * Slice 1 — DB-stored journey specs, loaded at boot.
 *
 *  - `loadJourneySpecsFromDb` returns enabled, well-formed rows as validated
 *    JourneySpecs, and TOLERATES a malformed / id-mismatched / disabled row by
 *    skipping it (never throwing — one bad row must not take down boot).
 *
 * DB: the shared TimescaleDB on port 5434; RUN-namespaced rows, cleaned in
 * afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeEach, describe, expect, it } from "vitest";

const { journeySpecs } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { createHogsendClient, loadAndRegisterDbSpecs, loadJourneySpecsFromDb } =
  await import("@hogsend/engine");
const { JourneyRegistry } = await import("@hogsend/core/registry");

const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: async () => {} },
  runs: { cancel: () => {}, get: () => {} },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

const RUN = `specdb-${Date.now()}`;

// Silent logger — the loader logs skips at error level; we don't want the noise.
const logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as typeof container.logger;

// The augmented TemplateRegistry requires real keys; these tests use
// checkpoint-only specs (no send_email), so an empty registry is fine at runtime.
const emptyTemplates = {} as typeof container.templates;

function goodSpec(id: string) {
  return {
    specVersion: 1,
    id,
    meta: {
      name: `DB spec ${id}`,
      enabled: true,
      trigger: { event: `${RUN}.trigger` },
      entryLimit: "unlimited",
      suppress: { minutes: 1 },
    },
    steps: [{ id: "note", type: "checkpoint" }],
  };
}

async function insertRow(row: {
  journeyId: string;
  spec: unknown;
  enabled?: boolean;
}) {
  await db.insert(journeySpecs).values({
    journeyId: row.journeyId,
    enabled: row.enabled ?? true,
    // biome-ignore lint/suspicious/noExplicitAny: raw jsonb payload under test
    spec: row.spec as any,
  });
}

beforeEach(async () => {
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
});

afterAll(async () => {
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
});

describe("loadJourneySpecsFromDb", () => {
  it("loads only enabled, well-formed rows and skips the rest", async () => {
    const okId = `${RUN}-ok`;
    const disabledId = `${RUN}-disabled`;
    const malformedId = `${RUN}-malformed`;
    const mismatchId = `${RUN}-mismatch`;

    await insertRow({ journeyId: okId, spec: goodSpec(okId) });
    await insertRow({
      journeyId: disabledId,
      spec: goodSpec(disabledId),
      enabled: false,
    });
    // Valid JSON, invalid spec (missing meta/steps).
    await insertRow({
      journeyId: malformedId,
      spec: { specVersion: 1, id: malformedId },
    });
    // Well-formed spec whose embedded id disagrees with the column.
    await insertRow({
      journeyId: mismatchId,
      spec: goodSpec(`${RUN}-other-id`),
    });

    const loaded = await loadJourneySpecsFromDb({ db, logger });
    const ids = loaded.map((s) => s.id);

    expect(ids).toContain(okId);
    expect(ids).not.toContain(disabledId); // enabled=false filtered by query
    expect(ids).not.toContain(malformedId); // parse failure skipped
    expect(ids).not.toContain(`${RUN}-other-id`); // id mismatch skipped
    // Every returned value is a fully-parsed spec.
    const ok = loaded.find((s) => s.id === okId);
    expect(ok?.meta.trigger.event).toBe(`${RUN}.trigger`);
    expect(ok?.steps).toHaveLength(1);
  });

  it("returns an empty array when there are no rows (never throws)", async () => {
    const loaded = await loadJourneySpecsFromDb({ db, logger });
    const mine = loaded.filter((s) => s.id.startsWith(RUN));
    expect(mine).toHaveLength(0);
  });

  it("a single malformed row does not prevent sibling rows from loading", async () => {
    await insertRow({
      journeyId: `${RUN}-bad`,
      spec: { not: "a spec" },
    });
    await insertRow({
      journeyId: `${RUN}-good`,
      spec: goodSpec(`${RUN}-good`),
    });

    const loaded = await loadJourneySpecsFromDb({ db, logger });
    const ids = loaded.map((s) => s.id);
    expect(ids).toContain(`${RUN}-good`);
    expect(ids).not.toContain(`${RUN}-bad`);
  });
});

describe("loadAndRegisterDbSpecs", () => {
  it("registers each DB spec into the registry and returns runnable journeys", async () => {
    const id = `${RUN}-adopt`;
    await insertRow({ journeyId: id, spec: goodSpec(id) });

    const registry = new JourneyRegistry();
    const adapted = await loadAndRegisterDbSpecs({
      db,
      registry,
      templates: emptyTemplates,
      logger,
    });

    const mine = adapted.filter((j) => j.meta.id.startsWith(RUN));
    expect(mine).toHaveLength(1);
    expect(mine[0]?.task).toBeDefined(); // a real Hatchet durable task
    expect(registry.get(id)?.trigger.event).toBe(`${RUN}.trigger`);
    // The registry indexes by trigger event too, so ingest routing resolves it.
    expect(
      registry.getByTriggerEvent(`${RUN}.trigger`).some((m) => m.id === id),
    ).toBe(true);
  });

  it("code wins: a DB spec colliding with a registered journey id is skipped", async () => {
    const id = `${RUN}-collide`;
    await insertRow({ journeyId: id, spec: goodSpec(id) });

    const registry = new JourneyRegistry();
    // Pre-register a "code" journey under the same id with a DIFFERENT trigger.
    registry.register({
      id,
      name: "Code journey (wins)",
      enabled: true,
      trigger: { event: "code.trigger" },
      entryLimit: "unlimited",
      suppress: { minutes: 1 },
    });

    const adapted = await loadAndRegisterDbSpecs({
      db,
      registry,
      templates: emptyTemplates,
      logger,
    });

    // The DB spec was skipped — not returned, and the registry still holds the
    // code journey's trigger, not the DB spec's.
    expect(adapted.some((j) => j.meta.id === id)).toBe(false);
    expect(registry.get(id)?.trigger.event).toBe("code.trigger");
  });
});
