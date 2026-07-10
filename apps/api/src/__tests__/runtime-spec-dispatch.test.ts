/**
 * Slice 2 P4 — ingestEvent dispatches the generic runner for a LIVE DB spec,
 * with the spec snapshot in the payload, and only for a matching trigger.
 *
 * The runner task is a module singleton bound to the real hatchet client, so we
 * spy on its `runNoWait` rather than letting it reach a real connection. The
 * ingest's own `hatchet` (events.push / exit cancel) is the injected mock.
 *
 * DB: shared TimescaleDB on 5434; RUN-namespaced rows cleaned in afterAll.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
process.env.RUNTIME_JOURNEY_SPECS = "true";

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const { contacts, journeySpecs, userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const {
  createHogsendClient,
  ingestEvent,
  journeySpecRunnerTask,
  resetRuntimeSpecStore,
} = await import("@hogsend/engine");

const mockHatchet = {
  durableTask: () => ({ run: () => {}, runNoWait: () => {} }),
  task: () => ({ run: () => {}, runNoWait: () => {} }),
  events: { push: vi.fn(async () => {}) },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: () => {},
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({
  overrides: { hatchet: mockHatchet },
});
const { db, logger, registry } = container;

const RUN = `rsd-${Date.now()}`;

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

async function insertSpec(id: string, event: string) {
  await db.insert(journeySpecs).values({
    journeyId: id,
    // biome-ignore lint/suspicious/noExplicitAny: raw jsonb under test
    spec: spec(id, event) as any,
  });
}

// Spy on the real runner task's dispatch so nothing reaches a live worker.
const runNoWaitSpy = vi
  .spyOn(journeySpecRunnerTask, "runNoWait")
  // biome-ignore lint/suspicious/noExplicitAny: minimal stub for the spy return
  .mockResolvedValue({ workflowRunId: "test-run" } as any);

beforeEach(async () => {
  runNoWaitSpy.mockClear();
  resetRuntimeSpecStore();
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
});

afterAll(async () => {
  await db.delete(journeySpecs).where(like(journeySpecs.journeyId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  runNoWaitSpy.mockRestore();
});

async function ingest(event: string, userId: string) {
  return ingestEvent({
    db,
    registry,
    hatchet: mockHatchet,
    logger,
    event: {
      event,
      userId,
      userEmail: `${userId}@example.com`,
      eventProperties: { plan: "pro" },
    },
  });
}

describe("ingestEvent → runtime spec dispatch", () => {
  it("dispatches the runner with the spec snapshot for a matching trigger", async () => {
    const id = `${RUN}-live`;
    await insertSpec(id, `${RUN}.fire`);

    await ingest(`${RUN}.fire`, `${RUN}-user1`);

    expect(runNoWaitSpy).toHaveBeenCalledTimes(1);
    const arg = runNoWaitSpy.mock.calls[0]?.[0] as unknown as {
      spec: { id: string };
      userId: string;
      properties: Record<string, unknown>;
    };
    expect(arg.spec.id).toBe(id); // full snapshot travels in the payload
    expect(arg.userId).toBe(`${RUN}-user1`);
    expect(arg.properties.plan).toBe("pro");
  });

  it("does NOT dispatch for a non-matching event", async () => {
    await insertSpec(`${RUN}-x`, `${RUN}.fire`);
    await ingest(`${RUN}.something-else`, `${RUN}-user2`);
    expect(runNoWaitSpy).not.toHaveBeenCalled();
  });

  it("dispatches once per matching spec (two specs, same trigger)", async () => {
    await insertSpec(`${RUN}-a`, `${RUN}.multi`);
    await insertSpec(`${RUN}-b`, `${RUN}.multi`);
    await ingest(`${RUN}.multi`, `${RUN}-user3`);
    expect(runNoWaitSpy).toHaveBeenCalledTimes(2);
    const ids = runNoWaitSpy.mock.calls
      .map((c) => (c[0] as unknown as { spec: { id: string } }).spec.id)
      .sort();
    expect(ids).toEqual([`${RUN}-a`, `${RUN}-b`]);
  });

  it("honors the RUNTIME_JOURNEY_SPECS=false opt-out", async () => {
    process.env.RUNTIME_JOURNEY_SPECS = "false";
    await insertSpec(`${RUN}-off`, `${RUN}.off`);
    await ingest(`${RUN}.off`, `${RUN}-user4`);
    expect(runNoWaitSpy).not.toHaveBeenCalled();
    process.env.RUNTIME_JOURNEY_SPECS = "true";
  });
});
