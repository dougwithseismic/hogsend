/**
 * Phase 6.1 — the read-only admin groups surface the Studio OBSERVE view
 * consumes. Same harness as admin-blueprints: `app.request()` directly against
 * the Hono app, real Postgres for `groups` / `group_memberships` / `contacts` /
 * `user_events`, Hatchet injected via the container override seam.
 *
 * Proves: the list surfaces seeded live groups with correct memberCount + total,
 * detail returns the group with recentMembers (joined to live contacts) and
 * recentEvents (matched via the `groups` jsonb association map), the members
 * endpoint paginates, an unknown group 404s, and the admin guard 401s an
 * unauthenticated request.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { contacts, groupMemberships, groups, userEvents } = await import(
  "@hogsend/db"
);
const { like } = await import("drizzle-orm");
const { journeys } = await import("../journeys/index.js");
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

const mockHatchet = {
  durableTask: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
    runAndWait: vi.fn(),
  })),
  task: vi.fn(() => ({
    run: vi.fn(),
    runNoWait: vi.fn(),
  })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// Run-scoped id prefix so parallel suites against the shared docker DB never
// collide; everything created here is swept in afterAll.
const RUN = `agr-${Date.now()}`;
const COMPANY_KEY = `${RUN}-acme.com`;
const TEAM_KEY = `${RUN}-team-eng`;

let companyId = "";
let contactAId = "";
let contactBId = "";

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  // group_memberships cascade off contacts/groups; delete groups explicitly.
  await db.delete(groups).where(like(groups.groupKey, `${RUN}%`));
});

async function seed() {
  const [company] = await db
    .insert(groups)
    .values({
      groupType: "company",
      groupKey: COMPANY_KEY,
      displayName: "Acme Inc",
      properties: { plan: "enterprise" },
    })
    .returning();
  if (!company) throw new Error("failed to seed company group");
  companyId = company.id;

  // A second, newer group (different type) to prove ordering + type filter.
  await db.insert(groups).values({
    groupType: "team",
    groupKey: TEAM_KEY,
    displayName: "Engineering",
    properties: {},
  });

  const [contactA, contactB] = await db
    .insert(contacts)
    .values([
      { externalId: `${RUN}-user-a`, email: `${RUN}-a@example.com` },
      { externalId: `${RUN}-user-b`, email: `${RUN}-b@example.com` },
    ])
    .returning();
  if (!contactA || !contactB) throw new Error("failed to seed contacts");
  contactAId = contactA.id;
  contactBId = contactB.id;

  await db.insert(groupMemberships).values([
    { groupId: companyId, contactId: contactAId, role: "admin" },
    { groupId: companyId, contactId: contactBId, role: "member" },
  ]);

  await db.insert(userEvents).values({
    userId: `${RUN}-user-a`,
    event: "feature.used",
    groups: { company: COMPANY_KEY },
    occurredAt: new Date(),
  });
}

await seed();

describe("GET /v1/admin/groups", () => {
  it("401s without auth", async () => {
    const res = await app.request("/v1/admin/groups");
    expect(res.status).toBe(401);
  });

  it("lists live groups with member counts and total", async () => {
    const res = await app.request("/v1/admin/groups?limit=100", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);

    const company = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === COMPANY_KEY,
    );
    expect(company).toBeDefined();
    expect(company.groupType).toBe("company");
    expect(company.displayName).toBe("Acme Inc");
    expect(company.properties).toEqual({ plan: "enterprise" });
    expect(company.memberCount).toBe(2);
    expect(company.firstSeenAt).toBeTruthy();
    expect(company.lastSeenAt).toBeTruthy();

    const team = body.groups.find(
      (g: { groupKey: string }) => g.groupKey === TEAM_KEY,
    );
    expect(team).toBeDefined();
    expect(team.memberCount).toBe(0);
  });

  it("filters by groupType", async () => {
    const res = await app.request("/v1/admin/groups?groupType=team&limit=100", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const g of body.groups) {
      expect(g.groupType).toBe("team");
    }
    expect(
      body.groups.some((g: { groupKey: string }) => g.groupKey === TEAM_KEY),
    ).toBe(true);
    expect(
      body.groups.some((g: { groupKey: string }) => g.groupKey === COMPANY_KEY),
    ).toBe(false);
  });
});

describe("GET /v1/admin/groups/{groupType}/{groupKey}", () => {
  it("returns group detail with recentMembers and recentEvents", async () => {
    const res = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(COMPANY_KEY)}`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();

    expect(body.group.id).toBe(companyId);
    expect(body.group.groupKey).toBe(COMPANY_KEY);
    expect(body.group.memberCount).toBe(2);

    expect(body.group.recentMembers).toHaveLength(2);
    const memberIds = body.group.recentMembers.map(
      (m: { contactId: string }) => m.contactId,
    );
    expect(memberIds).toContain(contactAId);
    expect(memberIds).toContain(contactBId);
    const admin = body.group.recentMembers.find(
      (m: { contactId: string }) => m.contactId === contactAId,
    );
    expect(admin.role).toBe("admin");
    expect(admin.email).toBe(`${RUN}-a@example.com`);
    expect(admin.externalId).toBe(`${RUN}-user-a`);

    expect(body.group.recentEvents).toHaveLength(1);
    expect(body.group.recentEvents[0].event).toBe("feature.used");
    expect(body.group.recentEvents[0].userId).toBe(`${RUN}-user-a`);
    expect(body.group.recentEvents[0].occurredAt).toBeTruthy();
  });

  it("404s for an unknown group", async () => {
    const res = await app.request(
      "/v1/admin/groups/company/does-not-exist", // no seeded row
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBeTruthy();
  });
});

describe("GET /v1/admin/groups/{groupType}/{groupKey}/members", () => {
  it("paginates members, newest-joined first", async () => {
    const res = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(COMPANY_KEY)}/members?limit=1`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.limit).toBe(1);
    expect(body.offset).toBe(0);
    expect(body.members).toHaveLength(1);
    expect(body.members[0].contactId).toBeTruthy();
    expect(body.members[0].joinedAt).toBeTruthy();

    // Page 2 returns the other member.
    const res2 = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(COMPANY_KEY)}/members?limit=1&offset=1`,
      { headers: AUTH_HEADER },
    );
    const body2 = await res2.json();
    expect(body2.members).toHaveLength(1);
    expect(body2.members[0].contactId).not.toBe(body.members[0].contactId);
  });

  it("404s for an unknown group", async () => {
    const res = await app.request(
      "/v1/admin/groups/company/does-not-exist/members",
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
  });
});
