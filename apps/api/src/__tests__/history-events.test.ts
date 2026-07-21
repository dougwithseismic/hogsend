/**
 * Real-DB tests for `ctx.history.events()` and `getUserContext`.
 *
 * Seeds `user_events` directly, exercises the method via `createJourneyContext`,
 * and verifies ordering, `limit`, and `within` behaviour. Mirrors the
 * `events-dataplane.test.ts` pattern: one TimescaleDB instance, RUN-namespaced
 * rows, full cleanup in `afterAll`.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const {
  contacts,
  emailSends,
  groupMemberships,
  groups,
  journeyStates,
  smsSends,
  userEvents,
} = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { hours } = await import("@hogsend/core");
const { createHogsendClient, createJourneyContext } = await import(
  "@hogsend/engine"
);
const { getUserContext } = await import("../lib/user-context.js");

// Minimal Hatchet stub — history.events() makes no Hatchet calls.
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
const { db } = container;

const RUN = `he-${Date.now()}`;
const USER_A = `${RUN}-user-a`;
const USER_B = `${RUN}-user-b`;
const EMAIL_A = `${USER_A}@example.com`;
const EMAIL_B = `${USER_B}@example.com`;

/** Build a minimal `createJourneyContext` config wired to the container's db. */
function makeCtx(
  userId: string,
  userEmail: string,
  extra?: Partial<Parameters<typeof createJourneyContext>[0]>,
) {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: vi.fn() as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    registry: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal test stub
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId: `${RUN}-state`,
    userId,
    userEmail,
    journeyContext: {},
    resolvedTimezone: "UTC",
    ...extra,
  });
}

// Seed: USER_A gets three events spread across time; USER_B gets one.
const NOW = new Date();
const ONE_HOUR_AGO = new Date(NOW.getTime() - 60 * 60 * 1000);
const THREE_HOURS_AGO = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);

beforeAll(async () => {
  await db.insert(userEvents).values([
    {
      userId: USER_A,
      event: "page.viewed",
      properties: { page: "/pricing" },
      occurredAt: THREE_HOURS_AGO,
    },
    {
      userId: USER_A,
      event: "feature.used",
      properties: { feature: "export" },
      occurredAt: ONE_HOUR_AGO,
    },
    {
      userId: USER_A,
      event: "plan.upgraded",
      properties: { plan: "pro" },
      occurredAt: NOW,
    },
    {
      userId: USER_B,
      event: "page.viewed",
      properties: { page: "/home" },
      occurredAt: NOW,
    },
  ]);

  // Upsert contacts so getUserContext's hasEvent queries have a known user.
  await db
    .insert(contacts)
    .values([
      { externalId: USER_A, email: EMAIL_A, properties: { plan: "pro" } },
      { externalId: USER_B, email: EMAIL_B, properties: {} },
    ])
    .onConflictDoNothing();
});

afterAll(async () => {
  await db.delete(emailSends).where(eq(emailSends.userId, USER_A));
  await db.delete(smsSends).where(eq(smsSends.userId, USER_A));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  // group_memberships cascade off contacts/groups.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
});

describe("ctx.history delivery", () => {
  it("counts only attempts that reached the provider", async () => {
    const sentAt = new Date("2026-07-15T08:00:00.000Z");
    const emailTemplate = `${RUN}-email-history`;
    const emailFailedOnly = `${RUN}-email-failed-only`;
    const smsTemplate = `${RUN}-sms-history`;
    const smsFailedOnly = `${RUN}-sms-failed-only`;
    const phone = `+1555${String(Date.now()).slice(-7)}`;

    await db.insert(emailSends).values([
      {
        userId: USER_A,
        userEmail: EMAIL_A,
        toEmail: EMAIL_A,
        fromEmail: "noreply@hogsend.com",
        subject: "sent",
        templateKey: emailTemplate,
        status: "sent",
        sentAt,
      },
      {
        userId: USER_A,
        userEmail: EMAIL_A,
        toEmail: EMAIL_A,
        fromEmail: "noreply@hogsend.com",
        subject: "blocked",
        templateKey: emailTemplate,
        status: "failed",
      },
      {
        userId: USER_A,
        userEmail: EMAIL_A,
        toEmail: EMAIL_A,
        fromEmail: "noreply@hogsend.com",
        subject: "blocked only",
        templateKey: emailFailedOnly,
        status: "failed",
      },
    ]);
    await db.insert(smsSends).values([
      {
        userId: USER_A,
        toPhone: phone,
        fromPhone: "+15005550006",
        body: "sent",
        templateKey: smsTemplate,
        status: "sent",
        sentAt,
      },
      {
        userId: USER_A,
        toPhone: phone,
        fromPhone: "+15005550006",
        body: "",
        templateKey: smsTemplate,
        status: "failed",
      },
      {
        userId: USER_A,
        toPhone: phone,
        fromPhone: "+15005550006",
        body: "",
        templateKey: smsFailedOnly,
        status: "failed",
      },
    ]);

    const ctx = makeCtx(USER_A, EMAIL_A);
    await expect(
      ctx.history.email({ email: EMAIL_A, template: emailTemplate }),
    ).resolves.toEqual({
      sent: true,
      lastSentAt: sentAt.toISOString(),
      count: 1,
    });
    await expect(
      ctx.history.email({ email: EMAIL_A, template: emailFailedOnly }),
    ).resolves.toEqual({ sent: false, lastSentAt: null, count: 0 });
    await expect(
      ctx.history.sms({ phone, template: smsTemplate }),
    ).resolves.toEqual({
      sent: true,
      lastSentAt: sentAt.toISOString(),
      count: 1,
    });
    await expect(
      ctx.history.sms({ phone, template: smsFailedOnly }),
    ).resolves.toEqual({ sent: false, lastSentAt: null, count: 0 });
  });
});

describe("ctx.history.events()", () => {
  it("returns all events newest-first by default", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);
    const result = await ctx.history.events({ userId: USER_A });

    // Must include our three seeded events in descending order.
    const names = result.map((e) => e.event);
    expect(names).toContain("plan.upgraded");
    expect(names).toContain("feature.used");
    expect(names).toContain("page.viewed");

    // Newest first — plan.upgraded (NOW) must appear before feature.used
    // (ONE_HOUR_AGO) which must appear before page.viewed (THREE_HOURS_AGO).
    const upgradeIdx = names.indexOf("plan.upgraded");
    const featureIdx = names.indexOf("feature.used");
    const pageIdx = names.indexOf("page.viewed");
    expect(upgradeIdx).toBeLessThan(featureIdx);
    expect(featureIdx).toBeLessThan(pageIdx);
  });

  it("respects the limit option", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);
    const result = await ctx.history.events({ userId: USER_A, limit: 1 });

    expect(result).toHaveLength(1);
    // limit:1 must return the newest event.
    expect(result[0]?.event).toBe("plan.upgraded");
  });

  it("respects the within option (excludes events older than the window)", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);
    // within 2h — includes ONE_HOUR_AGO + NOW, excludes THREE_HOURS_AGO.
    const result = await ctx.history.events({
      userId: USER_A,
      within: hours(2),
    });

    const names = result.map((e) => e.event);
    expect(names).toContain("plan.upgraded");
    expect(names).toContain("feature.used");
    expect(names).not.toContain("page.viewed");
  });

  it("scopes to the specified userId (does not bleed into other users)", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);
    const result = await ctx.history.events({ userId: USER_A });

    // USER_B's page.viewed (/home) must not appear in USER_A's events.
    const userBEvents = result.filter(
      (e) =>
        e.event === "page.viewed" &&
        (e.properties as Record<string, unknown>)?.page === "/home",
    );
    expect(userBEvents).toHaveLength(0);
  });

  it("returns events with the correct shape (event, properties, occurredAt ISO)", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);
    const result = await ctx.history.events({ userId: USER_A, limit: 1 });

    const first = result[0];
    expect(first).toBeDefined();
    expect(typeof first?.event).toBe("string");
    expect(typeof first?.occurredAt).toBe("string");
    // occurredAt must be a valid ISO 8601 string.
    expect(new Date(first?.occurredAt ?? "").toISOString()).toBe(
      first?.occurredAt,
    );
    // properties is an object (not null for our seeded events).
    expect(first?.properties).not.toBeNull();
    expect(typeof first?.properties).toBe("object");
  });

  it("returns an empty array when the user has no events", async () => {
    const ctx = makeCtx("nonexistent-user-xyz", "nope@example.com");
    const result = await ctx.history.events({ userId: "nonexistent-user-xyz" });
    expect(result).toEqual([]);
  });

  it("defaults to limit 50", async () => {
    // Insert 55 events for a fresh user and assert exactly 50 come back.
    const LIMIT_USER = `${RUN}-limit-user`;
    const inserts = Array.from({ length: 55 }, (_, i) => ({
      userId: LIMIT_USER,
      event: `evt.${i}`,
      properties: { i },
      occurredAt: new Date(NOW.getTime() - i * 60_000),
    }));
    await db.insert(userEvents).values(inserts);

    try {
      const ctx = makeCtx(LIMIT_USER, `${LIMIT_USER}@example.com`);
      const result = await ctx.history.events({ userId: LIMIT_USER });
      expect(result).toHaveLength(50);
    } finally {
      await db.delete(userEvents).where(eq(userEvents.userId, LIMIT_USER));
    }
  });
});

describe("getUserContext()", () => {
  it("assembles the full bundle with contact, events, and email fields", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A);

    const user = {
      id: USER_A,
      email: EMAIL_A,
      properties: { plan: "pro" as const },
      stateId: `${RUN}-state`,
      journeyId: "test-journey",
      journeyName: "Test Journey",
    };

    const bundle = await getUserContext(ctx, user);

    expect(bundle.contact.id).toBe(USER_A);
    expect(bundle.contact.email).toBe(EMAIL_A);
    expect(bundle.contact.properties).toMatchObject({ plan: "pro" });

    // events must include the seeded rows, newest first.
    expect(bundle.events.length).toBeGreaterThanOrEqual(3);
    expect(bundle.events[0]?.event).toBe("plan.upgraded");

    // email engagement signals are present (false since we didn't seed
    // email.opened / email.link_clicked events for this user).
    expect(bundle.email).toBeDefined();
    expect(typeof bundle.email.everOpened).toBe("boolean");
    expect(typeof bundle.email.everClicked).toBe("boolean");
  });

  it("omits posthog when POSTHOG_API_KEY is not set", async () => {
    // getPostHog() returns undefined without POSTHOG_API_KEY — posthog field
    // must be absent from the bundle (not undefined-but-present, absent).
    const ctx = makeCtx(USER_A, EMAIL_A);
    const user = {
      id: USER_A,
      email: EMAIL_A,
      properties: {},
      stateId: `${RUN}-state`,
      journeyId: "test-journey",
      journeyName: "Test Journey",
    };

    const bundle = await getUserContext(ctx, user);
    expect("posthog" in bundle).toBe(false);
  });
});

describe("ctx.history.hasEvent — group scope", () => {
  const GROUP_KEY = `${RUN}-acme.com`;
  const MEMBER = `${RUN}-member`;
  const GROUP_EVENT = "deal.closed";
  const JOURNEY_ID = `${RUN}-journey`;

  beforeAll(async () => {
    // Another member's events carrying the group association — one recent,
    // one outside a 2h `within` window. The enrolled USER_A has none.
    await db.insert(userEvents).values([
      {
        userId: MEMBER,
        event: GROUP_EVENT,
        properties: { amount: 100 },
        groups: { company: GROUP_KEY },
        occurredAt: NOW,
      },
      {
        userId: MEMBER,
        event: GROUP_EVENT,
        properties: { amount: 50 },
        groups: { company: GROUP_KEY },
        occurredAt: THREE_HOURS_AGO,
      },
      // Same event under a DIFFERENT group key — must never match.
      {
        userId: `${RUN}-outsider`,
        event: GROUP_EVENT,
        properties: {},
        groups: { company: `${RUN}-other.com` },
        occurredAt: NOW,
      },
    ]);
  });

  it("finds another member's event via an explicit group key", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A, { journeyId: JOURNEY_ID });
    await expect(
      ctx.history.hasEvent({
        userId: USER_A,
        event: GROUP_EVENT,
        group: { type: "company", key: GROUP_KEY },
      }),
    ).resolves.toEqual({ found: true, count: 2 });
  });

  it("respects `within` on the group leg", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A, { journeyId: JOURNEY_ID });
    await expect(
      ctx.history.hasEvent({
        userId: USER_A,
        event: GROUP_EVENT,
        within: hours(2),
        group: { type: "company", key: GROUP_KEY },
      }),
    ).resolves.toEqual({ found: true, count: 1 });
  });

  it("leaves the userId path unchanged when `group` is absent", async () => {
    const ctx = makeCtx(USER_A, EMAIL_A, { journeyId: JOURNEY_ID });
    // Group REPLACES userId scoping — without it, USER_A has no deal.closed.
    await expect(
      ctx.history.hasEvent({ userId: USER_A, event: GROUP_EVENT }),
    ).resolves.toEqual({ found: false, count: 0 });
    await expect(
      ctx.history.hasEvent({ userId: USER_A, event: "page.viewed" }),
    ).resolves.toMatchObject({ found: true });
  });

  it("auto-resolves a bare group type WITHOUT recording __groupKeys__", async () => {
    // Enrolled contact with a sole live membership of the group.
    const [contact] = await db
      .insert(contacts)
      .values({
        externalId: `${RUN}-grp-contact`,
        email: `${RUN}-grp-contact@example.com`,
      })
      .returning({ id: contacts.id });
    const [group] = await db
      .insert(groups)
      .values({ groupType: "company", groupKey: GROUP_KEY })
      .returning({ id: groups.id });
    if (!contact || !group) throw new Error("seed failed");
    await db
      .insert(groupMemberships)
      .values({ groupId: group.id, contactId: contact.id });
    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: USER_A,
        userEmail: EMAIL_A,
        journeyId: JOURNEY_ID,
        currentNodeId: "start",
        status: "active",
      })
      .returning({ id: journeyStates.id });
    if (!state) throw new Error("seed failed");

    const ctx = makeCtx(USER_A, EMAIL_A, {
      stateId: state.id,
      journeyId: JOURNEY_ID,
      contactId: contact.id,
    });
    await expect(
      ctx.history.hasEvent({
        userId: USER_A,
        event: GROUP_EVENT,
        group: "company",
      }),
    ).resolves.toEqual({ found: true, count: 2 });

    // READ-ONLY resolution: the state row's context must stay untouched.
    const [row] = await db
      .select({ context: journeyStates.context })
      .from(journeyStates)
      .where(eq(journeyStates.id, state.id));
    const context = (row?.context ?? {}) as Record<string, unknown>;
    expect(context.__groupKeys__).toBeUndefined();
  });
});
