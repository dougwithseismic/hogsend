import type { CrmStageEvent, HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, crmLinks, crmSyncCursors, deals, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray } = await import("drizzle-orm");
const { createHogsendClient, defineCrmProvider, runCrmReconcile } =
  await import("@hogsend/engine");

const RUN = `crmr-${Date.now()}`;
const EMAIL = `${RUN}@example.com`;

const pollCalls: Array<string | null> = [];
let pollEvents: CrmStageEvent[] = [];
let failPoll = false;

const pollingCrm = defineCrmProvider({
  meta: { id: "pollcrm", name: "Polling CRM" },
  capabilities: {
    auth: "apiKey",
    nativeStageWebhook: false,
    valueInWebhookPayload: false,
    atomicUpsert: false,
  },
  async pushLead() {
    return {};
  },
  verifyWebhook() {
    return [];
  },
  parseWebhook() {
    return [];
  },
  async poll(cursor) {
    pollCalls.push(cursor);
    if (failPoll) throw new Error("api down");
    return { events: pollEvents, nextCursor: `${RUN}-next` };
  },
});

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

// createHogsendClient installs the CRM sync singleton the sweep reads.
const container = createHogsendClient({
  crm: {
    provider: pollingCrm,
    stageMaps: { pollcrm: { "*": { won: "sold" } } },
  },
  overrides: { hatchet: mockHatchet },
});
const { db, logger } = container;

afterAll(async () => {
  const rows = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.email, EMAIL));
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    await db.delete(userEvents).where(inArray(userEvents.userId, ids));
    await db.delete(deals).where(inArray(deals.contactId, ids));
    await db.delete(crmLinks).where(inArray(crmLinks.contactId, ids));
  }
  await db.delete(contacts).where(eq(contacts.email, EMAIL));
  await db.delete(crmSyncCursors).where(eq(crmSyncCursors.provider, "pollcrm"));
});

describe("crm-reconcile sweep", () => {
  it("polls with a null cursor first, ingests, and persists the next cursor", async () => {
    pollEvents = [
      {
        dealId: `${RUN}-deal`,
        email: EMAIL,
        stageId: "won",
        value: { amount: 9000, currency: "GBP" },
        occurredAt: "2026-07-12T12:00:00.000Z",
        raw: {},
      },
    ];
    const result = await runCrmReconcile({
      db,
      logger,
      hatchet: mockHatchet,
    });
    expect(result).toEqual({ polled: 1, ingested: 1 });
    expect(pollCalls).toEqual([null]);

    const cursorRows = await db
      .select()
      .from(crmSyncCursors)
      .where(eq(crmSyncCursors.provider, "pollcrm"));
    expect(cursorRows[0]?.cursor).toBe(`${RUN}-next`);
    expect(cursorRows[0]?.lastError).toBeNull();

    const dealRows = await db
      .select()
      .from(deals)
      .where(eq(deals.externalId, `${RUN}-deal`));
    expect(dealRows[0]?.canonicalStage).toBe("sold");
  });

  it("re-observation dedups on the spine; the cursor still advances", async () => {
    const result = await runCrmReconcile({ db, logger, hatchet: mockHatchet });
    expect(result.polled).toBe(1);
    expect(result.ingested).toBe(0);
    expect(pollCalls[1]).toBe(`${RUN}-next`);
  });

  it("a failing provider records lastError and keeps the cursor", async () => {
    failPoll = true;
    const result = await runCrmReconcile({ db, logger, hatchet: mockHatchet });
    expect(result.polled).toBe(0);
    const cursorRows = await db
      .select()
      .from(crmSyncCursors)
      .where(eq(crmSyncCursors.provider, "pollcrm"));
    expect(cursorRows[0]?.cursor).toBe(`${RUN}-next`);
    expect(cursorRows[0]?.lastError).toMatchObject({ message: "api down" });
    failPoll = false;
  });
});
