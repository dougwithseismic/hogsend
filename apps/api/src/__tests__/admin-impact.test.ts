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

// ---------- Task 2: version cohorts ----------

describe("GET /v1/admin/journeys/{id}/impact — version cohorts", () => {
  const J = `${RUN}-vjour`;
  const DAY = 24 * 60 * 60 * 1000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY);

  it("groups by hash with same-hash contemporaneous controls (interleaved created_at)", async () => {
    // hash A and hash B interleave in time (blue-green deploy): a date
    // window would cross-contaminate; same-hash matching must not.
    // Label pick trap: lexicographic max("v9-old","a2-new") = "v9-old";
    // latest-by-created_at = "a2-new".
    await seedState({
      userId: `${RUN}-v-a1`,
      journeyId: J,
      hash: "aaaaaaaaaaaa",
      label: "v9-old",
      createdAt: at(20),
    });
    await seedState({
      userId: `${RUN}-v-b1`,
      journeyId: J,
      hash: "bbbbbbbbbbbb",
      label: "v2",
      createdAt: at(15),
    });
    await seedState({
      userId: `${RUN}-v-a2`,
      journeyId: J,
      hash: "aaaaaaaaaaaa",
      label: "a2-new",
      createdAt: at(10),
    });
    await seedState({
      userId: `${RUN}-v-b2`,
      journeyId: J,
      hash: "bbbbbbbbbbbb",
      label: "v2",
      createdAt: at(5),
    });
    await seedState({
      userId: `${RUN}-v-ha`,
      journeyId: J,
      status: "held_out",
      hash: "aaaaaaaaaaaa",
      createdAt: at(19),
    });
    await seedState({
      userId: `${RUN}-v-hb`,
      journeyId: J,
      status: "held_out",
      hash: "bbbbbbbbbbbb",
      createdAt: at(14),
    });
    // pre-versioning row (NULL-hash bucket)
    await seedState({
      userId: `${RUN}-v-n1`,
      journeyId: J,
      hash: null,
      createdAt: at(30),
    });
    // converters: one treated + one CONTROL converter, both under hash A
    await seedConversion({ userKey: `${RUN}-v-a1`, occurredAt: at(1) });
    await seedConversion({ userKey: `${RUN}-v-ha`, occurredAt: at(2) });

    const res = await app.request(`/v1/admin/journeys/${J}/impact`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();

    // newest first by first activity: min(created_at) desc → B, A, null
    expect(body.versions.map((v: { hash: string | null }) => v.hash)).toEqual([
      "bbbbbbbbbbbb",
      "aaaaaaaaaaaa",
      null,
    ]);

    const a = body.versions[1];
    expect(a.label).toBe("a2-new"); // latest-by-created_at, NOT max()
    expect(a.enrollments).toBe(2);
    expect(a.converters).toBe(1);
    expect(a.rate).toBeCloseTo(0.5);
    expect(a.firstEnrolledAt).not.toBeNull();
    expect(a.lastEnrolledAt).not.toBeNull();
    expect(new Date(a.firstEnrolledAt).getTime()).toBeLessThan(
      new Date(a.lastEnrolledAt).getTime(),
    );
    expect(a.liftVsControl).not.toBeNull();
    expect(a.liftVsControl.causal).toBe(true);
    expect(a.liftVsControl.control).toEqual({
      contacts: 1,
      converters: 1,
      rate: 1,
    });

    const b = body.versions[0];
    // same-hash matching: hash A's control converter must NOT leak into B
    expect(b.label).toBe("v2");
    expect(b.liftVsControl.control).toEqual({
      contacts: 1,
      converters: 0,
      rate: 0,
    });

    const unversioned = body.versions[2];
    expect(unversioned.hash).toBeNull();
    expect(unversioned.enrollments).toBe(1);
    expect(unversioned.label).toBeNull();
    // no held_out rows carry the NULL hash → no causal block
    expect(unversioned.liftVsControl).toBeNull();
  });

  it("a hash with only held_out rows renders enrollments 0 / firstEnrolledAt null", async () => {
    await seedState({
      userId: `${RUN}-v-hc`,
      journeyId: J,
      status: "held_out",
      hash: "cccccccccccc",
      createdAt: at(3),
    });
    const res = await app.request(`/v1/admin/journeys/${J}/impact`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();
    const cRow = body.versions.find(
      (v: { hash: string | null }) => v.hash === "cccccccccccc",
    );
    expect(cRow.enrollments).toBe(0);
    expect(cRow.converters).toBe(0);
    expect(cRow.rate).toBe(0);
    expect(cRow.firstEnrolledAt).toBeNull();
    expect(cRow.lastEnrolledAt).toBeNull();
    expect(cRow.liftVsControl).not.toBeNull();
    expect(cRow.liftVsControl.control.contacts).toBe(1);
  });

  it("windows by days: rows older than the window are excluded", async () => {
    await seedState({
      userId: `${RUN}-v-old`,
      journeyId: J,
      hash: "dddddddddddd",
      createdAt: at(120),
    });
    const res = await app.request(`/v1/admin/journeys/${J}/impact?days=90`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();
    expect(
      body.versions.find(
        (v: { hash: string | null }) => v.hash === "dddddddddddd",
      ),
    ).toBeUndefined();
  });
});

// ---------- Task 3: variant arms ----------

describe("GET /v1/admin/journeys/{id}/impact — variant arms", () => {
  const J = `${RUN}-vart`;

  it("enumerates arms from the jsonb bag with quotes stripped, excludes bag-less and held_out rows, joins engagement, and lifts vs the WHOLE holdout", async () => {
    const s1 = await seedState({
      userId: `${RUN}-x-u1`,
      journeyId: J,
      context: { __variants__: { subject: "setup" } },
    });
    await seedState({
      userId: `${RUN}-x-u2`,
      journeyId: J,
      context: { __variants__: { subject: "outcome" } },
    });
    const s3 = await seedState({
      userId: `${RUN}-x-u3`,
      journeyId: J,
      context: { __variants__: { subject: "setup" } },
    });
    // bag-less treated row: enrolled before the experiment shipped —
    // excluded from arms, still counted in overall treatment
    await seedState({ userId: `${RUN}-x-u4`, journeyId: J });
    // held_out rows: the shared control cohort for every arm
    await seedState({
      userId: `${RUN}-x-h1`,
      journeyId: J,
      status: "held_out",
    });
    // belt-and-suspenders: a held_out row WITH a bag must still be excluded
    await seedState({
      userId: `${RUN}-x-h2`,
      journeyId: J,
      status: "held_out",
      context: { __variants__: { subject: "setup" } },
    });
    await seedConversion({ userKey: `${RUN}-x-u1` });

    await db.insert(emailSends).values([
      {
        journeyStateId: s1,
        fromEmail: "no-reply@example.test",
        toEmail: `${RUN}-x-u1@example.test`,
        subject: "t",
        openedAt: new Date(),
        clickedAt: new Date(),
      },
      {
        journeyStateId: s1,
        fromEmail: "no-reply@example.test",
        toEmail: `${RUN}-x-u1@example.test`,
        subject: "t",
      },
      {
        journeyStateId: s3,
        fromEmail: "no-reply@example.test",
        toEmail: `${RUN}-x-u3@example.test`,
        subject: "t",
      },
    ]);

    const res = await app.request(`/v1/admin/journeys/${J}/impact`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();

    expect(body.variants).toHaveLength(1);
    const v = body.variants[0];
    expect(v.key).toBe("subject");
    // quote-stripping: jsonb_each_text unwraps the recordOnce JSON-string
    // values — a jsonb_each implementation would leak "\"setup\""
    expect(v.arms.map((a: { arm: string }) => a.arm)).toEqual([
      "outcome",
      "setup",
    ]);

    const setup = v.arms[1];
    expect(setup.enrollments).toBe(2); // u1 + u3; held_out u-h2 excluded
    expect(setup.converters).toBe(1);
    expect(setup.rate).toBeCloseTo(0.5);
    expect(setup.engagement).toEqual({
      causal: false,
      sends: 3,
      opened: 1,
      clicked: 1,
    });
    // arm vs the WHOLE held-out cohort (2 control contacts)
    expect(setup.liftVsControl).not.toBeNull();
    expect(setup.liftVsControl.causal).toBe(true);
    expect(typeof setup.liftVsControl.suppressed).toBe("boolean");

    const outcome = v.arms[0];
    expect(outcome.enrollments).toBe(1);
    expect(outcome.engagement).toEqual({
      causal: false,
      sends: 0,
      opened: 0,
      clicked: 0,
    });

    // arm cohorts may sum below the treated total (bag-less u4) — labeled,
    // never forced into a pseudo-arm
    expect(body.overall.treatment.contacts).toBe(4);
    expect(setup.enrollments + outcome.enrollments).toBeLessThan(
      body.overall.treatment.contacts,
    );
  });

  it("untrusted arm strings ride as data — enumerated verbatim, never a crash", async () => {
    await seedState({
      userId: `${RUN}-x-u9`,
      journeyId: J,
      context: { __variants__: { subject: "<img src=x onerror=1>" } },
    });
    const res = await app.request(`/v1/admin/journeys/${J}/impact`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.variants[0].arms.map((a: { arm: string }) => a.arm)).toContain(
      "<img src=x onerror=1>",
    );
  });

  it("liftVsControl is null when the journey has no held-out contacts", async () => {
    const J2 = `${RUN}-vart2`;
    await seedState({
      userId: `${RUN}-y-u1`,
      journeyId: J2,
      context: { __variants__: { subject: "setup" } },
    });
    const res = await app.request(`/v1/admin/journeys/${J2}/impact`, {
      headers: AUTH_HEADER,
    });
    const body = await res.json();
    expect(body.variants).toHaveLength(1);
    expect(body.variants[0].arms[0].liftVsControl).toBeNull();
    expect(body.variants[0].arms[0].engagement.causal).toBe(false);
  });
});

// ---------- Task 4: overview journeys ----------

describe("GET /v1/admin/impact/overview — journeys", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/impact/overview");
    expect(res.status).toBe(401);
  });

  it("unions states-observed and ledger-only journeys, flags registration, nests causal literals", async () => {
    // DB-only id: unregistered, in-window states
    await seedState({ userId: `${RUN}-o-u1`, journeyId: `${RUN}-db-only` });
    // ledger-only id: in-window credits, NO states — "this journey
    // attributed £X" must not vanish because enrollments predate the window
    const convId = await seedConversion({ userKey: `${RUN}-o-u2` });
    await db.insert(attributionCredits).values({
      conversionId: convId,
      model: "linear",
      touchpointEventId: crypto.randomUUID(),
      touchpointEvent: "email.link_clicked",
      channel: "email",
      touchpointAt: new Date(),
      weight: 1,
      value: 40,
      currency: "USD",
      journeyId: `${RUN}-ledger-only`,
      convertedAt: new Date(),
    });

    const res = await app.request("/v1/admin/impact/overview", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.days).toBe(90);
    expect(body.model).toBe("linear");
    expect(body.rankedBy).toBe("converters");

    const rows: Array<Record<string, any>> = body.journeys;
    const dbOnly = rows.find((j) => j.journeyId === `${RUN}-db-only`);
    expect(dbOnly).toBeDefined();
    expect(dbOnly?.registered).toBe(false);
    expect(dbOnly?.name).toBeNull();
    expect(dbOnly?.goalDefinitionId).toBeNull();
    expect(dbOnly?.holdoutPercent).toBeNull();
    expect(dbOnly?.observational).toMatchObject({
      causal: false,
      enrollments: 1,
      converters: 0,
      rate: 0,
    });
    expect(dbOnly?.attributed).toEqual({
      causal: false,
      model: "linear",
      values: [],
    });
    expect(dbOnly?.lift).toBeNull();

    const ledgerOnly = rows.find((j) => j.journeyId === `${RUN}-ledger-only`);
    expect(ledgerOnly).toBeDefined();
    expect(ledgerOnly?.registered).toBe(false);
    expect(ledgerOnly?.observational).toEqual({
      causal: false,
      enrollments: 0,
      converters: 0,
      rate: 0,
    });
    expect(ledgerOnly?.attributed.causal).toBe(false);
    expect(ledgerOnly?.attributed.values).toEqual([
      { currency: "USD", value: 40, conversions: 1 },
    ]);

    // registered journey enrichment + goal-scoped swap: base any-definition
    // converters for goal-journey would be 2 (g-u1 sale + g-u2 other); the
    // per-journey goal WHERE swaps to 1 with enrollments intact
    const goal = rows.find((j) => j.journeyId === `${RUN}-goal-journey`);
    expect(goal).toBeDefined();
    expect(goal?.registered).toBe(true);
    expect(goal?.name).toBe("Impact Goal Journey");
    expect(goal?.versionLabel).toBeNull(); // seeded rows carried no label
    expect(goal?.goalDefinitionId).toBe(`${RUN}-sale`);
    expect(goal?.holdoutPercent).toBe(10);
    expect(goal?.observational.enrollments).toBe(2);
    expect(goal?.observational.converters).toBe(1);
    // CAUSAL — held-out cohort exists in window (g-h1 from Task 1)
    expect(goal?.lift).not.toBeNull();
    expect(goal?.lift.causal).toBe(true);
    expect(goal?.lift.control).toEqual({
      contacts: 1,
      converters: 0,
      rate: 0,
    });
    expect(typeof goal?.lift.suppressed).toBe("boolean");
  });

  it("sums exactly ONE model's credits; the model query param switches it", async () => {
    const convId = await seedConversion({ userKey: `${RUN}-o-u3` });
    const base = {
      conversionId: convId,
      touchpointEvent: "email.link_clicked",
      channel: "email",
      touchpointAt: new Date(),
      journeyId: `${RUN}-model-j`,
      convertedAt: new Date(),
    };
    await db.insert(attributionCredits).values([
      {
        ...base,
        model: "linear",
        touchpointEventId: crypto.randomUUID(),
        weight: 0.5,
        value: 10,
        currency: "USD",
      },
      {
        ...base,
        model: "linear",
        touchpointEventId: crypto.randomUUID(),
        weight: 0.5,
        value: 10,
        currency: "USD",
      },
      {
        ...base,
        model: "first",
        touchpointEventId: crypto.randomUUID(),
        weight: 1,
        value: 99,
        currency: "USD",
      },
    ]);

    const linear = await (
      await app.request("/v1/admin/impact/overview", {
        headers: AUTH_HEADER,
      })
    ).json();
    const linearRow = linear.journeys.find(
      (j: { journeyId: string }) => j.journeyId === `${RUN}-model-j`,
    );
    expect(linearRow.attributed.model).toBe("linear");
    expect(linearRow.attributed.values).toEqual([
      { currency: "USD", value: 20, conversions: 1 },
    ]);

    const first = await (
      await app.request("/v1/admin/impact/overview?model=first", {
        headers: AUTH_HEADER,
      })
    ).json();
    expect(first.model).toBe("first");
    const firstRow = first.journeys.find(
      (j: { journeyId: string }) => j.journeyId === `${RUN}-model-j`,
    );
    expect(firstRow.attributed.model).toBe("first");
    expect(firstRow.attributed.values).toEqual([
      { currency: "USD", value: 99, conversions: 1 },
    ]);
  });

  it("keeps per-currency values separate — never summed across currencies", async () => {
    const convId = await seedConversion({ userKey: `${RUN}-o-u4` });
    const base = {
      conversionId: convId,
      model: "linear",
      touchpointEvent: "email.link_clicked",
      channel: "email",
      touchpointAt: new Date(),
      journeyId: `${RUN}-fx-j`,
      convertedAt: new Date(),
    };
    await db.insert(attributionCredits).values([
      {
        ...base,
        touchpointEventId: crypto.randomUUID(),
        weight: 0.5,
        value: 10,
        currency: "USD",
      },
      {
        ...base,
        touchpointEventId: crypto.randomUUID(),
        weight: 0.5,
        value: 5,
        currency: "EUR",
      },
    ]);
    const body = await (
      await app.request("/v1/admin/impact/overview", {
        headers: AUTH_HEADER,
      })
    ).json();
    const row = body.journeys.find(
      (j: { journeyId: string }) => j.journeyId === `${RUN}-fx-j`,
    );
    expect(row.attributed.values).toHaveLength(2);
    expect(row.attributed.values).toEqual(
      expect.arrayContaining([
        { currency: "USD", value: 10, conversions: 0.5 },
        { currency: "EUR", value: 5, conversions: 0.5 },
      ]),
    );
  });

  it("ranks by converters desc, enrollments desc, journeyId asc", async () => {
    // rank-a: 2 converters / 2 enrolled; rank-b: 1 / 3; rank-c: 1 / 1
    await seedState({ userId: `${RUN}-r-a1`, journeyId: `${RUN}-rank-a` });
    await seedState({ userId: `${RUN}-r-a2`, journeyId: `${RUN}-rank-a` });
    await seedConversion({ userKey: `${RUN}-r-a1` });
    await seedConversion({ userKey: `${RUN}-r-a2` });
    await seedState({ userId: `${RUN}-r-b1`, journeyId: `${RUN}-rank-b` });
    await seedState({ userId: `${RUN}-r-b2`, journeyId: `${RUN}-rank-b` });
    await seedState({ userId: `${RUN}-r-b3`, journeyId: `${RUN}-rank-b` });
    await seedConversion({ userKey: `${RUN}-r-b1` });
    await seedState({ userId: `${RUN}-r-c1`, journeyId: `${RUN}-rank-c` });
    await seedConversion({ userKey: `${RUN}-r-c1` });

    const body = await (
      await app.request("/v1/admin/impact/overview", {
        headers: AUTH_HEADER,
      })
    ).json();
    const ids = body.journeys.map((j: { journeyId: string }) => j.journeyId);
    const ia = ids.indexOf(`${RUN}-rank-a`);
    const ib = ids.indexOf(`${RUN}-rank-b`);
    const ic = ids.indexOf(`${RUN}-rank-c`);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ia).toBeLessThan(ib); // 2 converters beats 1
    expect(ib).toBeLessThan(ic); // ties on converters → enrollments desc
  });
});
