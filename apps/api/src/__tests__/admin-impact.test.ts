import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  attributionCredits,
  campaigns,
  contacts,
  conversions,
  emailSends,
  journeyStates,
  userEvents,
} = await import("@hogsend/db");
const { eq, inArray, like } = await import("drizzle-orm");
const { createApp, createHogsendClient, defineConversion, defineJourney } =
  await import("@hogsend/engine");

const RUN = `impact-${Date.now()}`;

const saleConversion = defineConversion({
  id: `${RUN}-sale`,
  name: "Test Sale",
  trigger: { event: `${RUN}.sold` },
});
const otherConversion = defineConversion({
  id: `${RUN}-other`,
  name: "Other Outcome",
  trigger: { event: `${RUN}.other` },
});

const goalJourney = defineJourney({
  meta: {
    id: `${RUN}-goal-journey`,
    name: "Impact Goal Journey",
    enabled: true,
    trigger: { event: `${RUN}.signup` },
    entryLimit: "once",
    suppress: { hours: 0 },
    holdout: { percent: 10 },
    goal: `${RUN}-sale`,
    version: "v1-test",
  },
  run: async () => {},
});
const plainJourney = defineJourney({
  meta: {
    id: `${RUN}-plain-journey`,
    name: "Impact Plain Journey",
    enabled: true,
    trigger: { event: `${RUN}.plain` },
    entryLimit: "once",
    suppress: { hours: 0 },
  },
  run: async () => {},
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

const container = createHogsendClient({
  journeys: [goalJourney, plainJourney],
  conversions: [saleConversion, otherConversion],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// ---------- RUN-scoped seeding helpers ----------

type SeedStatus =
  | "active"
  | "waiting"
  | "completed"
  | "failed"
  | "exited"
  | "held_out";

const seedState = async (opts: {
  userId: string;
  journeyId: string;
  status?: SeedStatus;
  createdAt?: Date;
  hash?: string | null;
  label?: string | null;
  context?: Record<string, unknown>;
}) => {
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: opts.userId,
      userEmail: `${opts.userId}@example.test`,
      journeyId: opts.journeyId,
      currentNodeId: "start",
      status: opts.status ?? "completed",
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
      journeyVersionHash: opts.hash ?? null,
      journeyVersionLabel: opts.label ?? null,
      context: opts.context ?? {},
    })
    .returning({ id: journeyStates.id });
  if (!row) throw new Error("seedState insert failed");
  return row.id;
};

const ensureContact = async (userKey: string) => {
  const existing = await db
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.externalId, userKey))
    .limit(1);
  if (existing[0]) return existing[0].id;
  const [row] = await db
    .insert(contacts)
    .values({ externalId: userKey, email: `${userKey}@example.test` })
    .returning({ id: contacts.id });
  if (!row) throw new Error("contact insert failed");
  return row.id;
};

const seedConversion = async (opts: {
  userKey: string;
  definitionId?: string;
  occurredAt?: Date;
  value?: number;
  currency?: string;
}) => {
  const contactId = await ensureContact(opts.userKey);
  const [event] = await db
    .insert(userEvents)
    .values({
      userId: opts.userKey,
      event: `${RUN}.sold`,
      occurredAt: opts.occurredAt ?? new Date(),
    })
    .returning({ id: userEvents.id });
  if (!event) throw new Error("event insert failed");
  const [conv] = await db
    .insert(conversions)
    .values({
      definitionId: opts.definitionId ?? `${RUN}-sale`,
      contactId,
      userKey: opts.userKey,
      eventId: event.id,
      value: opts.value,
      currency: opts.currency,
      occurredAt: opts.occurredAt ?? new Date(),
    })
    .returning({ id: conversions.id });
  if (!conv) throw new Error("conversion insert failed");
  return conv.id;
};

afterAll(async () => {
  const convRows = await db
    .select({ id: conversions.id })
    .from(conversions)
    .where(like(conversions.userKey, `${RUN}%`));
  const convIds = convRows.map((r) => r.id);
  if (convIds.length > 0) {
    await db
      .delete(attributionCredits)
      .where(inArray(attributionCredits.conversionId, convIds));
    await db.delete(conversions).where(inArray(conversions.id, convIds));
  }
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(emailSends).where(like(emailSends.toEmail, `${RUN}%`));
  await db
    .delete(journeyStates)
    .where(like(journeyStates.journeyId, `${RUN}%`));
  await db.delete(campaigns).where(like(campaigns.name, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
});

// ---------- Task 1: auth, 404 guard, goal resolution, overall ----------

describe("GET /v1/admin/journeys/{id}/impact — auth + 404 guard", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-goal-journey/impact`,
    );
    expect(res.status).toBe(401);
  });

  it("404s for an id that is unregistered AND has no states", async () => {
    const res = await app.request(`/v1/admin/journeys/${RUN}-ghost/impact`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });

  it("200s for an unregistered id WITH states (blueprint enrollments)", async () => {
    await seedState({
      userId: `${RUN}-bp-u1`,
      journeyId: `${RUN}-blueprint`,
    });
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-blueprint/impact`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.goal).toEqual({
      definitionId: null,
      source: "none",
      name: null,
    });
    expect(body.holdout).toBeNull();
    expect(body.currentVersionHash).toBeNull();
    expect(body.currentVersionLabel).toBeNull();
  });
});

describe("GET /v1/admin/journeys/{id}/impact — goal resolution", () => {
  it("defaults to meta.goal (source 'goal') with the definition name and registry identity", async () => {
    await seedState({
      userId: `${RUN}-g-u1`,
      journeyId: `${RUN}-goal-journey`,
    });
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-goal-journey/impact`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.journeyId).toBe(`${RUN}-goal-journey`);
    expect(body.days).toBe(90);
    expect(body.goal).toEqual({
      definitionId: `${RUN}-sale`,
      source: "goal",
      name: "Test Sale",
    });
    expect(body.holdout).toEqual({ percent: 10 });
    // Studio-required current-definition identity, from the D0-fixed registry
    expect(body.currentVersionHash).toBe(goalJourney.meta.versionHash);
    expect(body.currentVersionLabel).toBe("v1-test");
  });

  it("an explicit definitionId query param beats meta.goal (source 'query')", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-goal-journey/impact?definitionId=${RUN}-other`,
      { headers: AUTH_HEADER },
    );
    const body = await res.json();
    expect(body.goal).toEqual({
      definitionId: `${RUN}-other`,
      source: "query",
      name: "Other Outcome",
    });
  });

  it("no goal anywhere → source 'none', null definitionId", async () => {
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-plain-journey/impact`,
      { headers: AUTH_HEADER },
    );
    const body = await res.json();
    expect(body.goal).toEqual({
      definitionId: null,
      source: "none",
      name: null,
    });
    expect(body.holdout).toBeNull();
  });
});

describe("GET /v1/admin/journeys/{id}/impact — overall block", () => {
  it("zero controls → causal false, verdict null (no Beta(1,1) ghost)", async () => {
    await seedState({
      userId: `${RUN}-p-u1`,
      journeyId: `${RUN}-plain-journey`,
    });
    await seedState({
      userId: `${RUN}-p-u2`,
      journeyId: `${RUN}-plain-journey`,
    });
    await seedState({
      userId: `${RUN}-p-u3`,
      journeyId: `${RUN}-plain-journey`,
    });
    // no goal on this journey → ANY definition counts as the outcome
    await seedConversion({
      userKey: `${RUN}-p-u1`,
      definitionId: `${RUN}-other`,
      value: 25,
      currency: "USD",
    });
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-plain-journey/impact`,
      { headers: AUTH_HEADER },
    );
    const body = await res.json();
    expect(body.overall.causal).toBe(false);
    expect(body.overall.verdict).toBeNull();
    expect(body.overall.treatment.contacts).toBe(3);
    expect(body.overall.treatment.converters).toBe(1);
    expect(body.overall.treatment.rate).toBeCloseTo(1 / 3);
    expect(body.overall.control).toMatchObject({
      contacts: 0,
      converters: 0,
      rate: 0,
    });
    expect(body.overall.treatment.value).toEqual([
      { currency: "USD", value: 25 },
    ]);
  });

  it("held-out cohort present → causal true with a verdict, goal-scoped converters", async () => {
    await seedState({
      userId: `${RUN}-g-u2`,
      journeyId: `${RUN}-goal-journey`,
    });
    await seedState({
      userId: `${RUN}-g-h1`,
      journeyId: `${RUN}-goal-journey`,
      status: "held_out",
    });
    await seedConversion({ userKey: `${RUN}-g-u1` });
    // a conversion on ANOTHER definition must NOT count under meta.goal
    await seedConversion({
      userKey: `${RUN}-g-u2`,
      definitionId: `${RUN}-other`,
    });
    const res = await app.request(
      `/v1/admin/journeys/${RUN}-goal-journey/impact`,
      { headers: AUTH_HEADER },
    );
    const body = await res.json();
    expect(body.overall.causal).toBe(true);
    expect(body.overall.treatment.contacts).toBe(2);
    expect(body.overall.treatment.converters).toBe(1);
    expect(body.overall.control.contacts).toBe(1);
    expect(body.overall.verdict).not.toBeNull();
    expect(typeof body.overall.verdict.suppressed).toBe("boolean");
    expect(typeof body.overall.verdict.smallSample).toBe("boolean");
  });
});
