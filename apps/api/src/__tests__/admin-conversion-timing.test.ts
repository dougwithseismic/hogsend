import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, conversions, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { inArray } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");

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
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };
const RUN = `acvt-${Date.now()}`;
const DEF = `${RUN}-purchase`;
const JOURNEY = `${RUN}-onboarding`;
const ANCHOR_EVENT = `${RUN}-signed_up`;

const DAY = 24 * 60 * 60 * 1000;
const base = new Date(Date.now() - 40 * DAY);
// Three subjects: A converts +2d, B converts +20d, C never converts.
const subjects = [
  { key: `${RUN}-A`, convertAfterDays: 2 },
  { key: `${RUN}-B`, convertAfterDays: 20 },
  { key: `${RUN}-C`, convertAfterDays: null },
] as const;
const contactIds: string[] = [];
const conversionIds: string[] = [];

beforeAll(async () => {
  for (const s of subjects) {
    const [contact] = await db
      .insert(contacts)
      .values({ email: `${s.key}@example.com`, externalId: s.key })
      .returning({ id: contacts.id });
    const contactId = contact?.id as string;
    contactIds.push(contactId);

    // Anchor event + a journey enrollment, both at `base`.
    await db.insert(userEvents).values({
      userId: s.key,
      event: ANCHOR_EVENT,
      properties: {},
      occurredAt: base,
    });
    await db.insert(journeyStates).values({
      userId: s.key,
      userEmail: `${s.key}@example.com`,
      journeyId: JOURNEY,
      currentNodeId: "done",
      status: "completed",
      createdAt: base,
    });

    if (s.convertAfterDays == null) continue;
    const convAt = new Date(base.getTime() + s.convertAfterDays * DAY);
    const [convEvent] = await db
      .insert(userEvents)
      .values({
        userId: s.key,
        event: `${RUN}-purchased`,
        properties: {},
        occurredAt: convAt,
      })
      .returning({ id: userEvents.id });
    const [conv] = await db
      .insert(conversions)
      .values({
        definitionId: DEF,
        contactId,
        userKey: s.key,
        eventId: convEvent?.id as string,
        value: 100,
        currency: "USD",
        occurredAt: convAt,
      })
      .returning({ id: conversions.id });
    conversionIds.push(conv?.id as string);
  }
});

afterAll(async () => {
  if (conversionIds.length > 0) {
    await db.delete(conversions).where(inArray(conversions.id, conversionIds));
  }
  const keys = subjects.map((s) => s.key);
  await db.delete(userEvents).where(inArray(userEvents.userId, keys));
  await db.delete(journeyStates).where(inArray(journeyStates.userId, keys));
  if (contactIds.length > 0) {
    await db.delete(contacts).where(inArray(contacts.id, contactIds));
  }
});

type TimingBody = {
  anchored: number;
  converted: number;
  rate: number;
  convertedWithin: { d1: number; d7: number; d14: number; d30: number };
  medianDays: number | null;
  p90Days: number | null;
  correlational: boolean;
  anchor: { type: string; id: string };
};

// Both anchors resolve to the same three subjects + conversions, so the
// distribution is identical — the join path differs, the answer must not.
describe("admin conversions — time-to-conversion", () => {
  it("computes latency distribution anchored on an event", async () => {
    const res = await app.request(
      `/v1/admin/conversions/timing?definitionId=${DEF}&anchorType=event&anchorId=${ANCHOR_EVENT}&days=90`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimingBody;
    expect(body.anchor).toEqual({ type: "event", id: ANCHOR_EVENT });
    expect(body.anchored).toBe(3);
    expect(body.converted).toBe(2);
    expect(body.rate).toBeCloseTo(2 / 3, 5);
    expect(body.convertedWithin).toEqual({ d1: 0, d7: 1, d14: 1, d30: 2 });
    // median of {2, 20} days = 11; p90 (linear interp) = 2 + 0.9*(20-2) = 18.2
    expect(body.medianDays).toBeCloseTo(11, 5);
    expect(body.p90Days).toBeCloseTo(18.2, 5);
    expect(body.correlational).toBe(true);
  });

  it("computes the same distribution anchored on a journey enrollment", async () => {
    const res = await app.request(
      `/v1/admin/conversions/timing?definitionId=${DEF}&anchorType=journey&anchorId=${JOURNEY}&days=90`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimingBody;
    expect(body.anchor).toEqual({ type: "journey", id: JOURNEY });
    expect(body.anchored).toBe(3);
    expect(body.converted).toBe(2);
    expect(body.convertedWithin).toEqual({ d1: 0, d7: 1, d14: 1, d30: 2 });
    expect(body.medianDays).toBeCloseTo(11, 5);
    expect(body.p90Days).toBeCloseTo(18.2, 5);
  });

  it("returns an empty distribution for an anchor with no subjects", async () => {
    const res = await app.request(
      `/v1/admin/conversions/timing?definitionId=${DEF}&anchorType=event&anchorId=${RUN}-nonexistent&days=90`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as TimingBody;
    expect(body.anchored).toBe(0);
    expect(body.converted).toBe(0);
    expect(body.rate).toBe(0);
    expect(body.medianDays).toBeNull();
    expect(body.p90Days).toBeNull();
  });
});
