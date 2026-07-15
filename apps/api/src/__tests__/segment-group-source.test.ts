import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

// DB-touching test: the Segment `group` transform writes a real `groups` row
// (via identifyGroup) and the returned IngestEvent is ingested to create the
// membership — point at the docker TimescaleDB, overriding the placeholder.
process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, groupMemberships, groups, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq } = await import("drizzle-orm");
const { createHogsendClient, ingestEvent, segmentSource } = await import(
  "@hogsend/engine"
);

// Hatchet mocked so ingesting the transform result never dials a live engine.
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

const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db, registry, hatchet, logger } = container;

// RUN-namespaced so the (groupType, groupKey) natural key + cleanup are precise.
const RUN = `segrp-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const SEG_USER = `${RUN}-seg-user`;
const COMPANY_KEY = `acme-${RUN}.com`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.event, "segment.group"));
  await db
    .delete(groups)
    .where(
      and(eq(groups.groupType, "company"), eq(groups.groupKey, COMPANY_KEY)),
    );
  await db.delete(contacts).where(eq(contacts.externalId, SEG_USER));
});

describe("Segment preset — `group` calls land (Part B)", () => {
  it("skips a group call with no groupId", async () => {
    const result = await segmentSource.transform(
      { type: "group", userId: SEG_USER, messageId: "m" },
      { db, logger },
    );
    expect(result).toBeNull();
  });

  it("writes the company group + traits and returns an association IngestEvent", async () => {
    const result = await segmentSource.transform(
      {
        type: "group",
        userId: SEG_USER,
        groupId: COMPANY_KEY,
        messageId: `msg_${RUN}`,
        traits: { name: "Acme Inc", plan: "enterprise", seats: 42 },
      },
      { db, logger },
    );

    // (a) The transform returns the association IngestEvent (segment.group).
    expect(result).not.toBeNull();
    expect(result?.event).toBe("segment.group");
    expect(result?.userId).toBe(SEG_USER);
    expect(result?.groups).toEqual({ company: COMPANY_KEY });
    expect(result?.eventProperties).toEqual({
      source: "segment",
      _segmentType: "group",
      groupId: COMPANY_KEY,
    });
    expect(result?.contactProperties).toEqual({});
    expect(result?.idempotencyKey).toBe(`msg_${RUN}`);

    // (b) A groups row exists for ('company', COMPANY_KEY) with the traits
    //     merged into `properties` (the HMAC-signed webhook may write props).
    const groupRows = await db
      .select()
      .from(groups)
      .where(
        and(eq(groups.groupType, "company"), eq(groups.groupKey, COMPANY_KEY)),
      );
    expect(groupRows).toHaveLength(1);
    const group = groupRows[0];
    if (!group) throw new Error("group row missing");
    expect(group.properties).toMatchObject({
      name: "Acme Inc",
      plan: "enterprise",
      seats: 42,
    });

    // (c) Ingesting the returned event resolves the contact + creates the
    //     membership via the existing associateGroups path.
    if (!result) throw new Error("no transform result");
    const ingested = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: result,
    });
    expect(ingested.stored).toBe(true);

    const contactRows = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(eq(contacts.externalId, SEG_USER))
      .limit(1);
    expect(contactRows).toHaveLength(1);
    const contactId = contactRows[0]?.id ?? "";

    const memberships = await db
      .select()
      .from(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, group.id),
          eq(groupMemberships.contactId, contactId),
        ),
      );
    expect(memberships).toHaveLength(1);
  });
});
