import { afterAll, describe, expect, it, vi } from "vitest";

// Same real test DB the engine singletons + the route container read.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

// Hatchet via the override seam — ingest's downstream push lands on a spy.
vi.mock("../lib/hatchet.js", () => ({
  hatchet: {
    durableTask: vi.fn(() => ({
      run: vi.fn(),
      runNoWait: vi.fn(),
      runAndWait: vi.fn(),
    })),
    task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
    events: { push: vi.fn() },
    runs: { cancel: vi.fn(), get: vi.fn() },
    worker: vi.fn(),
  },
}));

const { contacts, userEvents } = await import("@hogsend/db");
const { inArray } = await import("drizzle-orm");
const { createHogsendClient, ingestEvent, resolveOrCreateContact } =
  await import("@hogsend/engine");

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
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db, registry, logger } = container;

const RUN = `prov-${Date.now()}`;
const createdIds: string[] = [];

async function readById(id: string) {
  const rows = await db
    .select()
    .from(contacts)
    .where(inArray(contacts.id, [id]))
    .limit(1);
  return rows[0];
}

afterAll(async () => {
  if (createdIds.length === 0) return;
  // Email-only contacts key their events on their row id (external_id ??
  // anonymous_id ?? id), so user_events.userId === contact.id here.
  await db.delete(userEvents).where(inArray(userEvents.userId, createdIds));
  await db.delete(contacts).where(inArray(contacts.id, createdIds));
});

describe("contact provenance (source / sourcedAt)", () => {
  it("stamps source + sourcedAt when a contact is created with a source", async () => {
    const r = await resolveOrCreateContact({
      db,
      email: `${RUN}-a@example.com`,
      source: "clay",
    });
    createdIds.push(r.id);
    expect(r.created).toBe(true);

    const row = await readById(r.id);
    expect(row?.source).toBe("clay");
    expect(row?.sourcedAt).toBeInstanceOf(Date);
  });

  it("is first-touch: a later, different source never overwrites the original", async () => {
    const email = `${RUN}-a@example.com`;
    const first = await readById(createdIds[0] as string);
    const firstSourcedAt = first?.sourcedAt?.getTime();

    // Re-resolving the same email fills-in-links onto the existing row.
    const r = await resolveOrCreateContact({ db, email, source: "attio" });
    expect(r.created).toBe(false);

    const row = await readById(r.id);
    expect(row?.source).toBe("clay"); // unchanged
    expect(row?.sourcedAt?.getTime()).toBe(firstSourcedAt); // unchanged
  });

  it("leaves provenance null when no source is supplied", async () => {
    const r = await resolveOrCreateContact({
      db,
      email: `${RUN}-b@example.com`,
    });
    createdIds.push(r.id);

    const row = await readById(r.id);
    expect(row?.source).toBeNull();
    expect(row?.sourcedAt).toBeNull();
  });

  it("stamps contact source from the ingest event's pipeline origin", async () => {
    const email = `${RUN}-c@example.com`;
    const res = await ingestEvent({
      db,
      registry,
      hatchet: mockHatchet,
      logger,
      event: {
        event: "prospect.sourced",
        userEmail: email,
        eventProperties: {},
        source: "clay",
      },
    });
    // Email-only contact → canonical key is its row id.
    createdIds.push(res.contactKey);

    const row = await readById(res.contactKey);
    expect(row?.source).toBe("clay");
    expect(row?.sourcedAt).toBeInstanceOf(Date);
  });
});
