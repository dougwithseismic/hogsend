/**
 * `resolveGroupScope` — the replay-stable group scope resolver (PRD 02).
 *
 * Real Postgres for `journey_states` / `contacts` / `groups` /
 * `group_memberships`; Hatchet injected via the container override seam.
 * Proves the exact resolution order (explicit key → trigger association →
 * recorded `__groupKeys__` → sole live membership), that only the membership
 * leg records, read-back convergence, `record: false` never writing, and the
 * three unresolvable throws with their exact message shapes.
 */

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

import { afterAll, describe, expect, it, vi } from "vitest";

const { contacts, groupMemberships, groups, journeyStates } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
const { GroupScopeUnresolvableError, createHogsendClient, resolveGroupScope } =
  await import("@hogsend/engine");

const mockHatchet = {
  durableTask: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn().mockResolvedValue(undefined) },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as ReturnType<typeof createHogsendClient>["hatchet"];
const container = createHogsendClient({ overrides: { hatchet: mockHatchet } });
const { db } = container;

// Run-scoped prefix so parallel suites against the shared docker DB never
// collide; everything created here is swept in afterAll.
const RUN = `gsr-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;

let seeded = 0;
async function freshState(context?: Record<string, unknown>): Promise<string> {
  seeded += 1;
  const [row] = await db
    .insert(journeyStates)
    .values({
      userId: `${RUN}-${seeded}`,
      userEmail: `${RUN}-${seeded}@example.com`,
      journeyId: JOURNEY_ID,
      currentNodeId: "start",
      status: "active",
      ...(context ? { context } : {}),
    })
    .returning({ id: journeyStates.id });
  return row?.id ?? "";
}

async function readContext(stateId: string): Promise<Record<string, unknown>> {
  const [row] = await db
    .select({ context: journeyStates.context })
    .from(journeyStates)
    .where(eq(journeyStates.id, stateId));
  return (row?.context ?? {}) as Record<string, unknown>;
}

async function seedContact(slug: string): Promise<string> {
  const [row] = await db
    .insert(contacts)
    .values({
      externalId: `${RUN}-${slug}`,
      email: `${RUN}-${slug}@example.com`,
    })
    .returning({ id: contacts.id });
  if (!row) throw new Error("failed to seed contact");
  return row.id;
}

async function seedGroup(opts: {
  type: string;
  key: string;
  deletedAt?: Date;
}): Promise<string> {
  const [row] = await db
    .insert(groups)
    .values({
      groupType: opts.type,
      groupKey: opts.key,
      ...(opts.deletedAt ? { deletedAt: opts.deletedAt } : {}),
    })
    .returning({ id: groups.id });
  if (!row) throw new Error("failed to seed group");
  return row.id;
}

async function addMember(groupId: string, contactId: string): Promise<void> {
  await db.insert(groupMemberships).values({ groupId, contactId });
}

afterAll(async () => {
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  // group_memberships cascade off contacts/groups.
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
});

describe("resolveGroupScope — resolution order", () => {
  it("explicit key wins and is NEVER recorded — even over a recorded value", async () => {
    const stateId = await freshState({
      __groupKeys__: { company: `${RUN}-recorded.com` },
    });
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId: undefined,
      triggerGroups: { company: `${RUN}-trigger.com` },
      option: { type: "company", key: `${RUN}-explicit.com` },
    });
    expect(scope).toEqual({ type: "company", key: `${RUN}-explicit.com` });
    // The recorded bag is untouched — explicit keys never write.
    const ctx = await readContext(stateId);
    expect(ctx.__groupKeys__).toEqual({ company: `${RUN}-recorded.com` });
  });

  it("trigger association wins over a recorded value and is NOT recorded", async () => {
    const stateId = await freshState({
      __groupKeys__: { company: `${RUN}-recorded.com` },
    });
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId: undefined,
      triggerGroups: { company: `${RUN}-trigger.com` },
      option: "company",
    });
    expect(scope).toEqual({ type: "company", key: `${RUN}-trigger.com` });
    const ctx = await readContext(stateId);
    expect(ctx.__groupKeys__).toEqual({ company: `${RUN}-recorded.com` });
  });

  it("returns a recorded __groupKeys__ value verbatim — even when a live membership disagrees", async () => {
    const contactId = await seedContact("recorded-vs-live");
    const groupId = await seedGroup({
      type: "company",
      key: `${RUN}-live.com`,
    });
    await addMember(groupId, contactId);
    const stateId = await freshState({
      __groupKeys__: { company: `${RUN}-recorded.com` },
    });
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
    });
    expect(scope).toEqual({ type: "company", key: `${RUN}-recorded.com` });
  });

  it("resolves the sole live membership and records it under __groupKeys__", async () => {
    const contactId = await seedContact("sole");
    const liveId = await seedGroup({ type: "company", key: `${RUN}-sole.com` });
    await addMember(liveId, contactId);
    // A soft-deleted same-type membership must NOT count toward ambiguity.
    const deadId = await seedGroup({
      type: "company",
      key: `${RUN}-dead.com`,
      deletedAt: new Date(),
    });
    await addMember(deadId, contactId);
    const stateId = await freshState();
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
    });
    expect(scope).toEqual({ type: "company", key: `${RUN}-sole.com` });
    const ctx = await readContext(stateId);
    expect(ctx.__groupKeys__).toEqual({ company: `${RUN}-sole.com` });
  });

  it("read-back convergence — a second call returns the same key from the record", async () => {
    const contactId = await seedContact("converge");
    const groupId = await seedGroup({
      type: "team",
      key: `${RUN}-team-eng`,
    });
    await addMember(groupId, contactId);
    const stateId = await freshState();
    const opts = {
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "team",
    };
    const first = await resolveGroupScope(opts);
    const second = await resolveGroupScope(opts);
    expect(first).toEqual({ type: "team", key: `${RUN}-team-eng` });
    expect(second).toEqual(first);
    const ctx = await readContext(stateId);
    expect(ctx.__groupKeys__).toEqual({ team: `${RUN}-team-eng` });
  });
});

describe("resolveGroupScope — record: false", () => {
  it("resolves the membership WITHOUT writing __groupKeys__", async () => {
    const contactId = await seedContact("nowrite");
    const groupId = await seedGroup({
      type: "company",
      key: `${RUN}-nowrite.com`,
    });
    await addMember(groupId, contactId);
    const stateId = await freshState();
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
      record: false,
    });
    expect(scope).toEqual({ type: "company", key: `${RUN}-nowrite.com` });
    const ctx = await readContext(stateId);
    expect(ctx.__groupKeys__).toBeUndefined();
  });

  it("still reads a recorded value first — order unchanged", async () => {
    const contactId = await seedContact("nowrite-recorded");
    const groupId = await seedGroup({
      type: "company",
      key: `${RUN}-nowrite-live.com`,
    });
    await addMember(groupId, contactId);
    const stateId = await freshState({
      __groupKeys__: { company: `${RUN}-nowrite-recorded.com` },
    });
    const scope = await resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
      record: false,
    });
    expect(scope).toEqual({
      type: "company",
      key: `${RUN}-nowrite-recorded.com`,
    });
  });
});

describe("resolveGroupScope — unresolvable throws", () => {
  it("throws the no-membership case naming the journey and type", async () => {
    const contactId = await seedContact("no-membership");
    const stateId = await freshState();
    const attempt = resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
    });
    await expect(attempt).rejects.toThrow(GroupScopeUnresolvableError);
    await expect(attempt).rejects.toThrow(JOURNEY_ID);
    await expect(attempt).rejects.toThrow('"company"');
    await expect(attempt).rejects.toThrow("no membership");
  });

  it("throws the ambiguous case naming the live membership count", async () => {
    const contactId = await seedContact("ambiguous");
    const aId = await seedGroup({ type: "company", key: `${RUN}-amb-a.com` });
    const bId = await seedGroup({ type: "company", key: `${RUN}-amb-b.com` });
    await addMember(aId, contactId);
    await addMember(bId, contactId);
    const stateId = await freshState();
    const attempt = resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId,
      triggerGroups: undefined,
      option: "company",
    });
    await expect(attempt).rejects.toThrow(GroupScopeUnresolvableError);
    await expect(attempt).rejects.toThrow(JOURNEY_ID);
    await expect(attempt).rejects.toThrow(
      'ambiguous: 2 memberships of type "company"',
    );
  });

  it("throws the no-membership case with a no-contact hint when contactId is undefined", async () => {
    const stateId = await freshState();
    const attempt = resolveGroupScope({
      db,
      stateId,
      journeyId: JOURNEY_ID,
      contactId: undefined,
      triggerGroups: undefined,
      option: "company",
    });
    await expect(attempt).rejects.toThrow(GroupScopeUnresolvableError);
    await expect(attempt).rejects.toThrow(JOURNEY_ID);
    await expect(attempt).rejects.toThrow("no membership");
    await expect(attempt).rejects.toThrow("no contact");
  });
});
