/**
 * Group-scoped `ctx.waitForEvent` (PRD 03): a wait carrying `group` resolves
 * on ANY member's matching event via the filtered leg's scan/CEL group
 * predicates, surfacing WHO acted as `actorUserId`. Real Postgres for
 * `journey_states` / `user_events` / `groups` / `group_memberships`; the
 * durable waitFor is stubbed (wait-for-event.test.ts pattern). Also proves
 * the exact `buildGroupEventFilter` CEL string (escaping included), the
 * contactId fallback for EMAIL-KEYED contacts through `executeJourneyRun`,
 * explicit-key-beats-recorded, where+group composition, and that plain
 * user-scoped waits now return `actorUserId`.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, describe, expect, it, vi } from "vitest";

type CapturedFn = (input: unknown, ctx: unknown) => Promise<unknown>;
// `vi.mock` factories are hoisted, so shared capture state lives in
// `vi.hoisted` (journey-version-stamping.test.ts pattern) — needed only for
// the executeJourneyRun leg (defineJourney registers via the singleton).
const { mockFns, hatchetMock } = vi.hoisted(() => {
  const mockFns: Record<string, CapturedFn> = {};
  const hatchetMock = () => ({
    hatchet: {
      durableTask: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(), runAndWait: vi.fn() };
      }),
      task: vi.fn((cfg: { name: string; fn: CapturedFn }) => {
        mockFns[cfg.name] = cfg.fn;
        return { run: vi.fn(), runNoWait: vi.fn(async () => ({})) };
      }),
      events: { push: vi.fn(async () => {}) },
      runs: { cancel: vi.fn(async () => {}), get: vi.fn() },
      worker: vi.fn(),
    },
  });
  return { mockFns, hatchetMock };
});
vi.mock("../../../../packages/engine/src/lib/hatchet.ts", hatchetMock);
vi.mock("../../../../packages/engine/src/lib/hatchet.js", hatchetMock);

const { contacts, groupMemberships, groups, journeyStates, userEvents } =
  await import("@hogsend/db");
const { and, eq, like } = await import("drizzle-orm");
const {
  buildGroupEventFilter,
  createHogsendClient,
  createJourneyContext,
  createMemoize,
  defineJourney,
  runWithJourneyBoundary,
} = await import("@hogsend/engine");
type JourneyBoundary = import("@hogsend/engine").JourneyBoundary;
type WaitForEventResult = import("@hogsend/core/types").WaitForEventResult;

const RUN = `gw-${Date.now()}`;
const EVENT = `${RUN}.answered`;
const JOURNEY_ID = `${RUN}-journey`;
const COMPANY_KEY = `${RUN}-acme.com`;

// The membership-resolution journey (executeJourneyRun leg) — captured via
// the mocked hatchet singleton, invoked directly with a stub durable ctx.
let observedWait: WaitForEventResult | undefined;
const groupJourney = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Group wait journey",
    enabled: true,
    trigger: { event: `${RUN}.enroll` },
    entryLimit: "unlimited",
    suppress: { hours: 0 },
  },
  run: async (_user, ctx) => {
    observedWait = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      // Covers the gap between the seeded answer and this wait — the same
      // send→wait gap lookback exists for in production.
      lookback: { minutes: 5 },
      group: "company",
    });
  },
});

const container = createHogsendClient({ journeys: [groupJourney] });
const { db } = container;

let seeded = 0;
async function freshState(
  context?: Record<string, unknown>,
): Promise<{ stateId: string; userId: string }> {
  seeded += 1;
  const userId = `${RUN}-enrolled-${seeded}`;
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId,
      userEmail: `${userId}@example.com`,
      journeyId: JOURNEY_ID,
      currentNodeId: "start",
      status: "active",
      ...(context ? { context } : {}),
    })
    .returning({ id: journeyStates.id });
  return { stateId: row?.id ?? "", userId };
}

async function seedEvent(opts: {
  userId: string;
  groups?: Record<string, string>;
  properties?: Record<string, unknown>;
  /** Explicit instant when recency between seeded rows must be deterministic
   * (two same-millisecond defaultNow rows have no stable desc order). */
  occurredAt?: Date;
}): Promise<void> {
  await db.insert(userEvents).values({
    userId: opts.userId,
    event: EVENT,
    properties: opts.properties ?? {},
    groups: opts.groups ?? null,
    ...(opts.occurredAt ? { occurredAt: opts.occurredAt } : {}),
  });
}

function makeCtx(opts: {
  stateId: string;
  userId: string;
  waitFor: ReturnType<typeof vi.fn>;
  triggerGroups?: Record<string, string>;
  contactId?: string;
}) {
  return createJourneyContext({
    db: db as Parameters<typeof createJourneyContext>[0]["db"],
    // biome-ignore lint/suspicious/noExplicitAny: unused by the wait path
    hatchet: {} as any,
    hatchetCtx: {
      sleepFor: vi.fn() as unknown as (d: unknown) => Promise<unknown>,
      waitFor: opts.waitFor as unknown as (
        c: unknown,
      ) => Promise<Record<string, unknown>>,
    },
    // biome-ignore lint/suspicious/noExplicitAny: unused by the wait path
    registry: {} as any,
    // biome-ignore lint/suspicious/noExplicitAny: minimal logger stub
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
    stateId: opts.stateId,
    userId: opts.userId,
    userEmail: `${opts.userId}@example.com`,
    journeyContext: {},
    resolvedTimezone: "UTC",
    journeyId: JOURNEY_ID,
    ...(opts.triggerGroups ? { triggerGroups: opts.triggerGroups } : {}),
    ...(opts.contactId ? { contactId: opts.contactId } : {}),
  });
}

/** Pull the rendered conditions out of the `Or(...)` arg passed to `waitFor`. */
function conditionsFrom(waitFor: ReturnType<typeof vi.fn>) {
  const orArg = waitFor.mock.calls[0]?.[0] as {
    conditions: Array<{ eventKey?: string; expression?: string }>;
  };
  return orArg.conditions;
}

afterAll(async () => {
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  // group_memberships cascade off contacts/groups.
  await db.delete(contacts).where(like(contacts.email, `${RUN}%`));
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
});

describe("buildGroupEventFilter", () => {
  it("renders the exact guarded CEL chain", () => {
    expect(buildGroupEventFilter("company", "acme.com")).toBe(
      "'groups' in input && 'company' in input.groups && " +
        "input.groups['company'] == 'acme.com'",
    );
  });

  it("escapes quotes and backslashes in BOTH literals", () => {
    // type `co'mp\any` → 'co\'mp\\any'; key `a'c\me` → 'a\'c\\me'.
    expect(buildGroupEventFilter("co'mp\\any", "a'c\\me")).toBe(
      "'groups' in input && 'co\\'mp\\\\any' in input.groups && " +
        "input.groups['co\\'mp\\\\any'] == 'a\\'c\\\\me'",
    );
  });
});

describe("group-scoped waitForEvent", () => {
  it("resumes on ANOTHER member's event via the re-arm scan path", async () => {
    const { stateId, userId } = await freshState();
    const actor = `${RUN}-actor-rearm`;
    // The event lands AFTER the wait is established: the stubbed waitFor
    // persists the row (as ingest would, before the push) then fires the
    // event branch; the loop's re-scan picks it up.
    const waitFor = vi.fn(async () => {
      await seedEvent({
        userId: actor,
        groups: { company: COMPANY_KEY },
        properties: { score: 9 },
      });
      return { CREATE: { event: [{}] } };
    });
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      group: { type: "company", key: COMPANY_KEY },
    });

    expect(res.timedOut).toBe(false);
    expect(res.actorUserId).toBe(actor);
    expect(res.properties).toMatchObject({ score: 9 });
    expect(waitFor).toHaveBeenCalledTimes(1);
  });

  it("ignores wrong-key and no-groups events; the CEL carries the group filter", async () => {
    const { stateId, userId } = await freshState();
    // Test-private key: with the 5-minute lookback below, the shared
    // COMPANY_KEY would also admit in-group rows other tests seeded.
    const awaitedKey = `${RUN}-awaited.com`;
    await seedEvent({
      userId: `${RUN}-actor-wrongkey`,
      groups: { company: `${RUN}-other.com` },
    });
    await seedEvent({ userId: `${RUN}-actor-nogroups` });
    const waitFor = vi.fn().mockResolvedValue({ CREATE: { timeout: [{}] } });
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      // Pull the seeded rows INSIDE the scan window so their exclusion is
      // attributable to the group predicate, not the time bound.
      lookback: { minutes: 5 },
      group: { type: "company", key: awaitedKey },
    });

    // Neither the pre-scan, the durable wait, nor the timeout final scan
    // matched — the wait timed out.
    expect(res).toEqual({ timedOut: true });
    expect(waitFor).toHaveBeenCalledTimes(1);
    const eventCond = conditionsFrom(waitFor).find((c) => c.eventKey === EVENT);
    expect(eventCond?.expression).toBe(
      buildGroupEventFilter("company", awaitedKey),
    );
  });

  it("pre-hit: a matching other-member row resolves immediately (no wait)", async () => {
    const { stateId, userId } = await freshState();
    const actor = `${RUN}-actor-prehit`;
    await seedEvent({ userId: actor, groups: { company: COMPANY_KEY } });
    const waitFor = vi.fn();
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      lookback: { minutes: 5 },
      group: { type: "company", key: COMPANY_KEY },
    });

    expect(res.timedOut).toBe(false);
    expect(res.actorUserId).toBe(actor);
    expect(waitFor).not.toHaveBeenCalled();
  });

  it("where + group compose: conditions evaluate on the ACTOR's properties", async () => {
    const { stateId, userId } = await freshState();
    const freeActor = `${RUN}-actor-free`;
    const proActor = `${RUN}-actor-pro`;
    // The pro row is OLDER so the free row is the NEWEST match: a dropped
    // `where` would surface the free actor (desc scan) and fail below.
    await seedEvent({
      userId: proActor,
      groups: { company: COMPANY_KEY },
      properties: { plan: "pro" },
      occurredAt: new Date(Date.now() - 2_000),
    });
    await seedEvent({
      userId: freeActor,
      groups: { company: COMPANY_KEY },
      properties: { plan: "free" },
      occurredAt: new Date(Date.now() - 1_000),
    });
    const waitFor = vi.fn();
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      lookback: { minutes: 5 },
      group: { type: "company", key: COMPANY_KEY },
      where: [
        { type: "property", property: "plan", operator: "eq", value: "pro" },
      ],
    });

    expect(res.timedOut).toBe(false);
    expect(res.actorUserId).toBe(proActor);
    expect(res.properties).toMatchObject({ plan: "pro" });
  });

  it("explicit key beats a recorded __groupKeys__ value", async () => {
    const recordedKey = `${RUN}-recorded.com`;
    const explicitKey = `${RUN}-explicit.com`;
    const { stateId, userId } = await freshState({
      __groupKeys__: { company: recordedKey },
    });
    const recordedActor = `${RUN}-actor-recorded`;
    const explicitActor = `${RUN}-actor-explicit`;
    await seedEvent({
      userId: recordedActor,
      groups: { company: recordedKey },
    });
    await seedEvent({
      userId: explicitActor,
      groups: { company: explicitKey },
    });
    const waitFor = vi.fn();
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      lookback: { minutes: 5 },
      group: { type: "company", key: explicitKey },
    });

    expect(res.timedOut).toBe(false);
    expect(res.actorUserId).toBe(explicitActor);
    // Explicit keys never write — the recorded bag is untouched.
    const [row] = await db
      .select({ context: journeyStates.context })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    expect((row?.context as Record<string, unknown>).__groupKeys__).toEqual({
      company: recordedKey,
    });
  });

  it("user-scoped wait returns actorUserId = the enrolled user", async () => {
    const { stateId, userId } = await freshState();
    const waitFor = vi.fn().mockResolvedValue({
      CREATE: {
        event: [{ id: "e1", data: { userId, properties: { ok: true } } }],
      },
    });
    const ctx = makeCtx({ stateId, userId, waitFor });

    const res = await ctx.waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
    });

    expect(res.timedOut).toBe(false);
    expect(res.actorUserId).toBe(userId);
  });
});

describe("sole-membership auto-resolution through executeJourneyRun", () => {
  it("resolves via the pushed contactId for an EMAIL-KEYED contact (NULL externalId)", async () => {
    // The contact is email-keyed: externalId NULL, so the timezone fetch by
    // externalId misses — the resolver MUST see the pushed contactId.
    const memberUserId = `${RUN}-member`;
    const [contact] = await db
      .insert(contacts)
      .values({ externalId: null, email: `${RUN}-member@example.com` })
      .returning({ id: contacts.id });
    if (!contact) throw new Error("failed to seed contact");
    const membershipKey = `${RUN}-membership.com`;
    const [group] = await db
      .insert(groups)
      .values({ groupType: "company", groupKey: membershipKey })
      .returning({ id: groups.id });
    if (!group) throw new Error("failed to seed group");
    await db
      .insert(groupMemberships)
      .values({ groupId: group.id, contactId: contact.id });

    // Another member's answer already persisted — the pre-hit scan resolves
    // the wait without the (unstubbed-to-fire) durable waitFor.
    const teammate = `${RUN}-teammate`;
    await seedEvent({
      userId: teammate,
      groups: { company: membershipKey },
    });

    const fn = mockFns[`journey-${JOURNEY_ID}`];
    if (!fn) throw new Error("journey fn was not captured");
    observedWait = undefined;
    const result = await fn(
      {
        userId: memberUserId,
        userEmail: `${RUN}-member@example.com`,
        properties: {},
        // As pushed by ingestEvent: no explicit key, no trigger association —
        // resolution must fall through to the sole live membership.
        groups: {},
        contactId: contact.id,
      },
      {
        workflowRunId: () => `${RUN}-run-1`,
        sleepFor: async () => ({}),
        waitFor: async () => ({ CREATE: { timeout: [{}] } }),
        now: async () => new Date(),
      },
    );

    expect(result).toMatchObject({ status: "completed" });
    // Re-widen: TS's narrowing can't see the closure write inside run().
    const wait = observedWait as WaitForEventResult | undefined;
    expect(wait?.timedOut).toBe(false);
    expect(wait?.actorUserId).toBe(teammate);
    // The membership-resolved key was recorded replay-stably.
    const [row] = await db
      .select({ context: journeyStates.context })
      .from(journeyStates)
      .where(eq(journeyStates.userId, memberUserId));
    expect((row?.context as Record<string, unknown>).__groupKeys__).toEqual({
      company: membershipKey,
    });
  });
});

describe("recorded wait outcome (__waits__ replay terminal mark)", () => {
  it("a replay-from-top returns the recorded outcome verbatim without re-arming", async () => {
    const { stateId, userId } = await freshState();
    const actor = `${RUN}-actor-replay`;
    await seedEvent({
      userId: actor,
      groups: { company: COMPANY_KEY },
      properties: { score: 4 },
    });

    // First pass: the scan path resolves the wait.
    const firstWaitFor = vi.fn();
    const first = await makeCtx({
      stateId,
      userId,
      waitFor: firstWaitFor,
    }).waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      lookback: { minutes: 5 },
      label: "team-answer",
      group: { type: "company", key: COMPANY_KEY },
    });
    expect(first).toEqual({
      timedOut: false,
      properties: { score: 4 },
      actorUserId: actor,
    });
    expect(firstWaitFor).not.toHaveBeenCalled();

    // The outcome was frozen set-once under __waits__[<nodeId>:result].
    const [row] = await db
      .select({ context: journeyStates.context })
      .from(journeyStates)
      .where(eq(journeyStates.id, stateId));
    const waits = (row?.context as Record<string, unknown>).__waits__ as
      | Record<string, unknown>
      | undefined;
    expect(waits?.["team-answer:result"]).toEqual(first);

    // Replay-from-top: fresh context, SAME stateId + label, the resolving row
    // GONE — only the recorded outcome can reproduce the answer.
    await db
      .delete(userEvents)
      .where(and(eq(userEvents.userId, actor), eq(userEvents.event, EVENT)));
    const replayWaitFor = vi.fn();
    const replay = await makeCtx({
      stateId,
      userId,
      waitFor: replayWaitFor,
    }).waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      lookback: { minutes: 5 },
      label: "team-answer",
      group: { type: "company", key: COMPANY_KEY },
    });
    expect(replay).toEqual(first);
    expect(replayWaitFor).not.toHaveBeenCalled();
  });

  it("a replay of a waitFor-resolved wait RE-ISSUES the identical durable call (#591)", async () => {
    // Hatchet's journal is positional and param-checked for completed entries:
    // a replay that skips the original waitFor (or re-computes its sleep
    // duration) fails the whole run with a non-determinism error. So the
    // replay must walk the same branch sequence — recorded scans return their
    // frozen misses even though the resolving row is NOW visible — and re-issue
    // the waitFor with byte-identical conditions.
    const { stateId, userId } = await freshState();
    const actor = `${RUN}-actor-journal`;

    // First pass: scans miss (no row yet); the durable waitFor "fires" the
    // event branch after persisting the resolving row (as ingest would), and
    // the post-branch scan concludes the wait.
    const firstWaitFor = vi.fn(async () => {
      await seedEvent({
        userId: actor,
        groups: { company: COMPANY_KEY },
        properties: { score: 9 },
      });
      return { CREATE: { event: [{}] } };
    });
    const first = await makeCtx({
      stateId,
      userId,
      waitFor: firstWaitFor,
    }).waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      label: "journal-answer",
      group: { type: "company", key: COMPANY_KEY },
    });
    expect(first).toEqual({
      timedOut: false,
      properties: { score: 9 },
      actorUserId: actor,
    });
    expect(firstWaitFor).toHaveBeenCalledTimes(1);

    // Replay-from-top: the resolving row is visible in the DB now, but the
    // recorded scan misses keep the control flow on the original path, so the
    // waitFor is issued AGAIN — with the SAME conditions (the journal would
    // answer it instantly) — and the outcome replays verbatim.
    const replayWaitFor = vi.fn(async () => ({ CREATE: { event: [{}] } }));
    const replay = await makeCtx({
      stateId,
      userId,
      waitFor: replayWaitFor,
    }).waitForEvent({
      event: EVENT,
      timeout: { hours: 1 },
      label: "journal-answer",
      group: { type: "company", key: COMPANY_KEY },
    });
    expect(replay).toEqual(first);
    expect(replayWaitFor).toHaveBeenCalledTimes(1);

    // Param-identical: same event CEL filter, same whole-seconds sleep.
    const conds = (fn: ReturnType<typeof vi.fn>) =>
      (
        fn.mock.calls[0]?.[0] as {
          conditions: Array<{
            eventKey?: string;
            expression?: string;
            sleepFor?: unknown;
          }>;
        }
      ).conditions.map((c) => ({
        eventKey: c.eventKey,
        expression: c.expression,
        sleepFor: c.sleepFor,
      }));
    expect(conds(replayWaitFor)).toEqual(conds(firstWaitFor));
  });

  it("two waits sharing a label in ONE run throw the loud collision error", async () => {
    const { stateId, userId } = await freshState();
    const actor = `${RUN}-actor-collide`;
    await seedEvent({ userId: actor, groups: { company: COMPANY_KEY } });
    const ctx = makeCtx({ stateId, userId, waitFor: vi.fn() });
    const boundary: JourneyBoundary = {
      stateId,
      runAnchor: stateId,
      currentLabel: undefined,
      seenKeys: new Set<string>(),
      seenRecordLabels: new Set<string>(),
      memoize: createMemoize({}),
    };
    const waitOpts = {
      event: EVENT,
      timeout: { hours: 1 } as const,
      lookback: { minutes: 5 } as const,
      label: "dup-label",
      group: { type: "company", key: COMPANY_KEY },
    };

    await expect(
      runWithJourneyBoundary(boundary, async () => {
        // First wait resolves (pre-hit); the second reuses the label and must
        // throw BEFORE any stale-outcome replay could fire.
        await ctx.waitForEvent(waitOpts);
        await ctx.waitForEvent(waitOpts);
      }),
    ).rejects.toThrow(/used twice in one journey run/);
  });
});
