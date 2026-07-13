/**
 * Impact plan §5.1 (backfill) + §5.2 (zero-config revenue conversion):
 * history replays through the idempotent conversion + ledger machinery, and
 * a fresh deploy converts trusted valued events with no configuration.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { attributionCredits, contacts, conversions, userEvents } = await import(
  "@hogsend/db"
);
const { eq, inArray, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConversion, ingestEvent } =
  await import("@hogsend/engine");

const RUN = `bf-${Date.now()}`;
const USER = `${RUN}-user`;

const bfConversion = defineConversion({
  id: `${RUN}-bf`,
  trigger: { event: `${RUN}.order` },
  attributionWindowDays: 30,
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

// No `conversions` option beyond the test def — the default `revenue`
// definition must self-seed (5.2).
const container = createHogsendClient({
  conversions: [bfConversion],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db, registry, hatchet, logger } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

afterAll(async () => {
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(inArray(conversions.definitionId, [`${RUN}-bf`, "revenue"]));
  const ids = convRows.map((r) => r.id);
  if (ids.length > 0) {
    await db
      .delete(attributionCredits)
      .where(inArray(attributionCredits.conversionId, ids));
  }
  // Deleting the test's user_events cascades its conversions (eventId FK).
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}-%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}-%`));
});

const send = (opts: {
  event: string;
  at: string;
  source: string;
  value?: number;
  userId?: string;
}) => {
  const userId = opts.userId ?? USER;
  return ingestEvent({
    db,
    registry,
    hatchet,
    logger,
    event: {
      event: opts.event,
      userId,
      eventProperties: {},
      ...(opts.value !== undefined
        ? { value: opts.value, currency: "GBP" }
        : {}),
      occurredAt: opts.at,
      idempotencyKey: `${RUN}:${userId}:${opts.event}:${opts.at}`,
      source: opts.source,
    },
  });
};

describe("zero-config revenue conversion (5.2)", () => {
  it("fires on any trusted valued event, skips quotes and browser events", async () => {
    const user = `${RUN}-zc`;
    // Trusted valued event → the built-in `revenue` definition fires.
    await send({
      event: `${RUN}.purchase`,
      at: "2026-07-10T09:00:00.000Z",
      source: "stripe",
      value: 49,
      userId: user,
    });
    // Quote-shaped: excluded (unrealized money).
    await send({
      event: "crm.deal_quoted",
      at: "2026-07-10T10:00:00.000Z",
      source: "crm",
      value: 5000,
      userId: user,
    });
    // Browser-minted value: excluded by the forged-value sources gate.
    await send({
      event: `${RUN}.fake`,
      at: "2026-07-10T11:00:00.000Z",
      source: "inapp",
      value: 999999,
      userId: user,
    });

    const fired = await db
      .select({ eventValue: conversions.value })
      .from(conversions)
      .where(eq(conversions.userKey, user));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toMatchObject({ eventValue: 49 });
  });
});

describe("attribution backfill (5.1)", () => {
  it("credits pre-existing history, is idempotent, and recomputes on demand", async () => {
    // Simulate PRE-UPGRADE history: rows written straight to user_events
    // (never evaluated) + the contact that owns them.
    const [contact] = await db
      .insert(contacts)
      .values({ externalId: USER, email: `${USER}@x.com` })
      .returning({ id: contacts.id });
    expect(contact).toBeTruthy();
    await db.insert(userEvents).values([
      {
        userId: USER,
        event: "email.link_clicked",
        properties: { journeyId: `${RUN}-j`, templateKey: "welcome" },
        occurredAt: new Date("2026-07-01T09:00:00.000Z"),
        source: "tracking",
      },
      {
        userId: USER,
        event: `${RUN}.order`,
        properties: {},
        value: 250,
        currency: "GBP",
        occurredAt: new Date("2026-07-03T09:00:00.000Z"),
        source: "stripe",
      },
    ]);

    // Loop the batch endpoint to completion, exactly like the CLI does.
    const backfill = async (body: Record<string, unknown>) => {
      let cursor: string | undefined;
      const totals = { conversionsFired: 0, creditsWritten: 0 };
      for (let i = 0; i < 50; i++) {
        const res = await app.request("/v1/admin/attribution/backfill", {
          method: "POST",
          headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, cursor }),
        });
        expect(res.status).toBe(200);
        const batch = (await res.json()) as {
          conversionsFired: number;
          creditsWritten: number;
          nextCursor: string | null;
        };
        totals.conversionsFired += batch.conversionsFired;
        totals.creditsWritten += batch.creditsWritten;
        if (!batch.nextCursor) return totals;
        cursor = batch.nextCursor;
      }
      throw new Error("backfill did not terminate");
    };

    const first = await backfill({ definitionId: `${RUN}-bf`, limit: 100 });
    expect(first.conversionsFired).toBe(1);
    expect(first.creditsWritten).toBe(1);

    const [conversion] = await db
      .select({ id: conversions.id })
      .from(conversions)
      .where(eq(conversions.definitionId, `${RUN}-bf`));
    expect(conversion).toBeTruthy();
    const credits = await db
      .select()
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, conversion?.id as string));
    // 8 models over a single touch = 8 rows, all journey-scoped.
    expect(credits.length).toBe(8);
    expect(credits.every((c) => c.journeyId === `${RUN}-j`)).toBe(true);

    // Idempotent: a second full run mints nothing new.
    const again = await backfill({ definitionId: `${RUN}-bf`, limit: 100 });
    expect(again.conversionsFired).toBe(0);
    expect(again.creditsWritten).toBe(0);

    // Recompute: delete-then-refill lands the same 8 rows.
    const recomputed = await backfill({
      definitionId: `${RUN}-bf`,
      limit: 100,
      recompute: true,
    });
    expect(recomputed.creditsWritten).toBe(1);
    const creditsAfter = await db
      .select()
      .from(attributionCredits)
      .where(eq(attributionCredits.conversionId, conversion?.id as string));
    expect(creditsAfter.length).toBe(8);

    // Guard: blanket recompute is refused.
    const blanket = await app.request("/v1/admin/attribution/backfill", {
      method: "POST",
      headers: { ...AUTH_HEADER, "Content-Type": "application/json" },
      body: JSON.stringify({ recompute: true }),
    });
    expect(blanket.status).toBe(400);
  });
});
