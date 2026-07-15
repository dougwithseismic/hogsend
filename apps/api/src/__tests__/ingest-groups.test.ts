import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, groupMemberships, groups, userEvents } = await import(
  "@hogsend/db"
);
const { and, eq } = await import("drizzle-orm");
const { createHogsendClient, ingestEvent } = await import("@hogsend/engine");

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

// Unique per run so the (groupType, groupKey) natural key never collides with a
// prior run's residue (and cleanup below is scoped to exactly these keys).
const RUN = `ingrp-${Date.now()}`;
const WITH_USER = `${RUN}-with`;
const WITHOUT_USER = `${RUN}-without`;
const COMPANY_KEY = `acme-${RUN}`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.event, `${RUN}.event`));
  // Deleting the group cascades its memberships; deleting the contacts cleans
  // up the WITHOUT-groups user too.
  await db
    .delete(groups)
    .where(
      and(eq(groups.groupType, "company"), eq(groups.groupKey, COMPANY_KEY)),
    );
  await db.delete(contacts).where(eq(contacts.externalId, WITH_USER));
  await db.delete(contacts).where(eq(contacts.externalId, WITHOUT_USER));
});

async function contactIdFor(externalId: string): Promise<string> {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, externalId))
    .limit(1);
  expect(rows.length).toBe(1);
  const row = rows[0];
  if (!row) throw new Error(`no contact for ${externalId}`);
  return row.id;
}

async function lastEventFor(userId: string) {
  const rows = await db
    .select()
    .from(userEvents)
    .where(eq(userEvents.userId, userId));
  expect(rows.length).toBeGreaterThan(0);
  return rows[rows.length - 1];
}

describe("ingestEvent — group dimension (Phase 2.2)", () => {
  it("persists user_events.groups, ensures the group row, and links the contact (WITH groups)", async () => {
    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.event`,
        userId: WITH_USER,
        eventProperties: { plan: "pro" },
        groups: { company: COMPANY_KEY },
      },
    });
    expect(result.stored).toBe(true);

    // (1) user_events.groups persisted verbatim.
    const row = await lastEventFor(WITH_USER);
    expect(row?.groups).toEqual({ company: COMPANY_KEY });

    // (2) a groups row exists for ('company', COMPANY_KEY).
    const groupRows = await db
      .select()
      .from(groups)
      .where(
        and(eq(groups.groupType, "company"), eq(groups.groupKey, COMPANY_KEY)),
      );
    expect(groupRows.length).toBe(1);
    const firstGroup = groupRows[0];
    if (!firstGroup) throw new Error("group row missing");
    const groupId = firstGroup.id;

    // (3) a group_memberships row links the resolved contact to that group.
    const contactId = await contactIdFor(WITH_USER);
    const memberships = await db
      .select()
      .from(groupMemberships)
      .where(
        and(
          eq(groupMemberships.groupId, groupId),
          eq(groupMemberships.contactId, contactId),
        ),
      );
    expect(memberships.length).toBe(1);
  });

  it("leaves groups null and creates no membership when the event carries no groups (no regression)", async () => {
    const result = await ingestEvent({
      db,
      registry,
      hatchet,
      logger,
      event: {
        event: `${RUN}.event`,
        userId: WITHOUT_USER,
        eventProperties: { plan: "free" },
      },
    });
    expect(result.stored).toBe(true);

    // user_events.groups is null (the additive column defaults to null).
    const row = await lastEventFor(WITHOUT_USER);
    expect(row?.groups).toBeNull();

    // The standalone association path never ran — the contact has no memberships.
    const contactId = await contactIdFor(WITHOUT_USER);
    const memberships = await db
      .select()
      .from(groupMemberships)
      .where(eq(groupMemberships.contactId, contactId));
    expect(memberships.length).toBe(0);
  });
});
