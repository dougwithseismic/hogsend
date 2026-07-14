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
// Phase 8.1 fixtures — a contact in two distinct-type groups + one with none.
const ORG_KEY = `${RUN}-globex.com`;
const SQUAD_KEY = `${RUN}-squad-x`;
// Count-consistency fixture — a group with one LIVE and one SOFT-DELETED member.
const GHOST_KEY = `${RUN}-ghost.com`;
// Phase 9.1 fixtures — revenue rollup + search/sort. A RUN-unique groupType
// isolates the three fixture groups from everything else in the shared DB, so
// the global (aggregate-first) sort order can be asserted exactly.
const REV_TYPE = `${RUN}-acct`;
const REV_A_KEY = `${RUN}-rev-a`;
const REV_B_KEY = `${RUN}-rev-b`;
const REV_C_KEY = `${RUN}-rev-c`;
const REV_A_NAME = `Alpha-${RUN}-Corp`;
// Mixed-currency fixture (its own type, so it never disturbs the sort fixture).
const MIX_TYPE = `${RUN}-mix`;
const MIX_KEY = `${RUN}-mixed.com`;
// ILIKE-metacharacter fixture: `_` is a single-char wildcard unless escaped.
const PROMO_TYPE = `${RUN}-promo`;
const PROMO_LITERAL_KEY = `${RUN}-promo_50`;
const PROMO_WILDCARD_KEY = `${RUN}-promoX50`;

let companyId = "";
let contactAId = "";
let contactBId = "";
let multiContactId = "";
let noGroupContactId = "";
let liveMemberId = "";

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

  // Phase 8.1 — the contact-detail groups projection. Two distinct-type groups
  // (a "company" ordered before a "team" by group_type ASC), one contact in
  // both (with/without a role), and a second contact in none.
  const [org, squad] = await db
    .insert(groups)
    .values([
      { groupType: "company", groupKey: ORG_KEY, displayName: "Globex" },
      { groupType: "team", groupKey: SQUAD_KEY, displayName: null },
    ])
    .returning();
  if (!org || !squad) throw new Error("failed to seed phase-8.1 groups");

  const [multi, solo] = await db
    .insert(contacts)
    .values([
      { externalId: `${RUN}-user-multi`, email: `${RUN}-multi@example.com` },
      { externalId: `${RUN}-user-solo`, email: `${RUN}-solo@example.com` },
    ])
    .returning();
  if (!multi || !solo) throw new Error("failed to seed phase-8.1 contacts");
  multiContactId = multi.id;
  noGroupContactId = solo.id;

  await db.insert(groupMemberships).values([
    { groupId: org.id, contactId: multiContactId, role: "owner" },
    { groupId: squad.id, contactId: multiContactId, role: null },
  ]);

  // Count-consistency fixture: a group with TWO memberships, one of whose
  // contacts is SOFT-deleted (what a merge loser / a deleted contact leaves
  // behind). The member LIST joins live contacts, so the member COUNT must join
  // them too — otherwise the header over-counts the rows it can actually show.
  const [ghost] = await db
    .insert(groups)
    .values({
      groupType: "company",
      groupKey: GHOST_KEY,
      displayName: "Ghostly",
    })
    .returning();
  if (!ghost) throw new Error("failed to seed ghost group");

  const [live, dead] = await db
    .insert(contacts)
    .values([
      { externalId: `${RUN}-user-live`, email: `${RUN}-live@example.com` },
      {
        externalId: `${RUN}-user-dead`,
        email: `${RUN}-dead@example.com`,
        deletedAt: new Date(),
      },
    ])
    .returning();
  if (!live || !dead) throw new Error("failed to seed ghost-group contacts");
  liveMemberId = live.id;

  await db.insert(groupMemberships).values([
    { groupId: ghost.id, contactId: live.id, role: "member" },
    { groupId: ghost.id, contactId: dead.id, role: "member" },
  ]);

  // Phase 9.1 — revenue rollup + search/sort. Three groups of a RUN-unique
  // type: A has the most money and NO members, C has the most members and no
  // money, so a revenue sort and a member sort must produce OPPOSITE orders.
  const [revA, revB, revC] = await db
    .insert(groups)
    .values([
      { groupType: REV_TYPE, groupKey: REV_A_KEY, displayName: REV_A_NAME },
      { groupType: REV_TYPE, groupKey: REV_B_KEY, displayName: "Beta Ltd" },
      { groupType: REV_TYPE, groupKey: REV_C_KEY, displayName: "Gamma GmbH" },
    ])
    .returning();
  if (!revA || !revB || !revC) throw new Error("failed to seed rev groups");

  await db.insert(userEvents).values([
    // A: 100 + 50 = 150.
    {
      userId: `${RUN}-user-a`,
      event: "deal.sold",
      value: 100,
      currency: "USD",
      groups: { [REV_TYPE]: REV_A_KEY },
    },
    {
      userId: `${RUN}-user-a`,
      event: "deal.sold",
      value: 50,
      currency: "USD",
      groups: { [REV_TYPE]: REV_A_KEY },
    },
    // B: 30.
    {
      userId: `${RUN}-user-b`,
      event: "deal.sold",
      value: 30,
      currency: "USD",
      groups: { [REV_TYPE]: REV_B_KEY },
    },
    // Same KEY, different group TYPE — containment must not cross-count this
    // into (REV_TYPE, REV_A_KEY).
    {
      userId: `${RUN}-user-b`,
      event: "deal.sold",
      value: 999,
      currency: "USD",
      groups: { [`${RUN}-other`]: REV_A_KEY },
    },
    // A funnel machinery event carries the SAME deal's value on every stage
    // change; the rollup shares the contact rollup's exclusion gate, so it must
    // not inflate A.
    {
      userId: `${RUN}-user-a`,
      event: "funnel.stage_changed",
      value: 777,
      currency: "USD",
      groups: { [REV_TYPE]: REV_A_KEY },
    },
    // An untagged valued event belongs to no group at all.
    {
      userId: `${RUN}-user-b`,
      event: "deal.sold",
      value: 12,
      currency: "USD",
    },
  ]);

  // Member counts: C = 2, B = 1, A = 0 (the inverse of the revenue order).
  await db.insert(groupMemberships).values([
    { groupId: revC.id, contactId: contactAId, role: "member" },
    { groupId: revC.id, contactId: contactBId, role: "member" },
    { groupId: revB.id, contactId: contactAId, role: "member" },
  ]);

  // Mixed-currency group: 100 USD + 100 GBP. These must NEVER add up to 200 —
  // the revenue spine's law is per-currency totals.
  await db
    .insert(groups)
    .values({ groupType: MIX_TYPE, groupKey: MIX_KEY, displayName: "Mixed" });
  await db.insert(userEvents).values([
    {
      userId: `${RUN}-user-a`,
      event: "deal.sold",
      value: 100,
      currency: "USD",
      groups: { [MIX_TYPE]: MIX_KEY },
    },
    {
      userId: `${RUN}-user-b`,
      event: "deal.sold",
      value: 100,
      currency: "GBP",
      groups: { [MIX_TYPE]: MIX_KEY },
    },
  ]);

  // Two keys that differ only where an unescaped ILIKE `_` would wildcard.
  await db.insert(groups).values([
    { groupType: PROMO_TYPE, groupKey: PROMO_LITERAL_KEY, displayName: null },
    { groupType: PROMO_TYPE, groupKey: PROMO_WILDCARD_KEY, displayName: null },
  ]);
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

describe("member counts exclude soft-deleted contacts (count == list)", () => {
  it("counts only live members on the list, the detail, and the members page", async () => {
    const list = await app.request("/v1/admin/groups?limit=100", {
      headers: AUTH_HEADER,
    });
    const listBody = await list.json();
    const ghost = listBody.groups.find(
      (g: { groupKey: string }) => g.groupKey === GHOST_KEY,
    );
    expect(ghost).toBeDefined();
    // Two membership rows, but only ONE has a live contact.
    expect(ghost.memberCount).toBe(1);

    const detail = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(GHOST_KEY)}`,
      { headers: AUTH_HEADER },
    );
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody.group.memberCount).toBe(1);
    expect(detailBody.group.recentMembers).toHaveLength(1);
    expect(detailBody.group.recentMembers[0].contactId).toBe(liveMemberId);

    const members = await app.request(
      `/v1/admin/groups/company/${encodeURIComponent(GHOST_KEY)}/members`,
      { headers: AUTH_HEADER },
    );
    const membersBody = await members.json();
    expect(membersBody.total).toBe(1);
    expect(membersBody.members).toHaveLength(1);
    expect(membersBody.members[0].contactId).toBe(liveMemberId);

    // The header count never disagrees with the list it heads.
    expect(ghost.memberCount).toBe(membersBody.total);
    expect(detailBody.group.memberCount).toBe(
      detailBody.group.recentMembers.length,
    );
  });
});

describe("GET /v1/admin/contacts/{id} — group memberships (Phase 8.1)", () => {
  it("returns the contact's groups, ordered by type then joined desc", async () => {
    const res = await app.request(`/v1/admin/contacts/${multiContactId}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toHaveLength(2);

    // group_type ASC → the "company" group sorts before the "team" group.
    expect(body.groups[0].groupType).toBe("company");
    expect(body.groups[0].groupKey).toBe(ORG_KEY);
    expect(body.groups[0].displayName).toBe("Globex");
    expect(body.groups[0].role).toBe("owner");
    expect(body.groups[0].joinedAt).toBeTruthy();

    expect(body.groups[1].groupType).toBe("team");
    expect(body.groups[1].groupKey).toBe(SQUAD_KEY);
    expect(body.groups[1].displayName).toBeNull();
    expect(body.groups[1].role).toBeNull();
    expect(body.groups[1].joinedAt).toBeTruthy();
  });

  it("returns an empty array for a contact with no memberships", async () => {
    const res = await app.request(`/v1/admin/contacts/${noGroupContactId}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.groups).toEqual([]);
  });
});

// --- Phase 9.1: revenue rollup + search/sort ---

interface RevenueTotal {
  currency: string | null;
  total: number;
}

interface ListedGroup {
  groupKey: string;
  revenueTotals: RevenueTotal[];
  memberCount: number;
}

async function listGroups(query: string): Promise<{
  groups: ListedGroup[];
  total: number;
}> {
  const res = await app.request(`/v1/admin/groups?${query}`, {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  return await res.json();
}

async function getGroup(groupType: string, groupKey: string) {
  const res = await app.request(
    `/v1/admin/groups/${encodeURIComponent(groupType)}/${encodeURIComponent(groupKey)}`,
    { headers: AUTH_HEADER },
  );
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.group;
}

describe("GET /v1/admin/groups — revenue rollup (Phase 9.1)", () => {
  it("sums each group's tagged valued events, without cross-counting", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(REV_TYPE)}&limit=100`,
    );
    const byKey = new Map(body.groups.map((g) => [g.groupKey, g]));

    // 100 + 50; the 999 tagged under a DIFFERENT group type with the same key
    // and the excluded 777 `funnel.stage_changed` never land here.
    expect(byKey.get(REV_A_KEY)?.revenueTotals).toEqual([
      { currency: "USD", total: 150 },
    ]);
    expect(byKey.get(REV_B_KEY)?.revenueTotals).toEqual([
      { currency: "USD", total: 30 },
    ]);
    // No valued events at all → an empty array, never a zero in no currency.
    expect(byKey.get(REV_C_KEY)?.revenueTotals).toEqual([]);
  });

  it("keeps currencies separate — a USD deal and a GBP deal never add", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(MIX_TYPE)}&limit=100`,
    );
    const mixed = body.groups.find((g) => g.groupKey === MIX_KEY);
    expect(mixed?.revenueTotals).toHaveLength(2);
    // Two entries of 100 — NOT one entry of 200 in no currency at all.
    expect(
      [...(mixed?.revenueTotals ?? [])].sort((a, b) =>
        String(a.currency).localeCompare(String(b.currency)),
      ),
    ).toEqual([
      { currency: "GBP", total: 100 },
      { currency: "USD", total: 100 },
    ]);

    // The detail agrees with the list, entry for entry.
    const detail = await getGroup(MIX_TYPE, MIX_KEY);
    expect(
      [...detail.revenueTotals].sort((a: RevenueTotal, b: RevenueTotal) =>
        String(a.currency).localeCompare(String(b.currency)),
      ),
    ).toEqual([
      { currency: "GBP", total: 100 },
      { currency: "USD", total: 100 },
    ]);
  });

  it("exposes per-currency revenue on the group detail", async () => {
    const group = await getGroup(REV_TYPE, REV_A_KEY);
    expect(group.revenueTotals).toEqual([{ currency: "USD", total: 150 }]);
    expect(group.memberCount).toBe(0);
  });

  it("groups with no valued events report empty totals on the detail", async () => {
    const group = await getGroup(REV_TYPE, REV_C_KEY);
    expect(group.revenueTotals).toEqual([]);
  });
});

describe("GET /v1/admin/groups — sort (Phase 9.1)", () => {
  // `sort=revenue` RANKS on the cross-currency sum — an ordering heuristic
  // (exact for a single-currency deployment, approximate for a mixed one). The
  // money it DISPLAYS stays per-currency in `revenueTotals`; the scalar never
  // reaches the response.
  it("orders by revenue across ALL groups, not just the page", async () => {
    // limit=1 → each page holds ONE row, so a page-local sort could not produce
    // a globally-correct sequence: the order must come from the aggregate.
    const pages = await Promise.all(
      [0, 1, 2].map((offset) =>
        listGroups(
          `groupType=${encodeURIComponent(REV_TYPE)}&sort=revenue&order=desc&limit=1&offset=${offset}`,
        ),
      ),
    );

    expect(pages.map((p) => p.groups.length)).toEqual([1, 1, 1]);
    expect(pages.map((p) => p.total)).toEqual([3, 3, 3]);
    expect(pages.map((p) => p.groups[0]?.groupKey)).toEqual([
      REV_A_KEY,
      REV_B_KEY,
      REV_C_KEY,
    ]);
    expect(pages.map((p) => p.groups[0]?.revenueTotals)).toEqual([
      [{ currency: "USD", total: 150 }],
      [{ currency: "USD", total: 30 }],
      [],
    ]);
  });

  it("reverses on order=asc", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(REV_TYPE)}&sort=revenue&order=asc&limit=100`,
    );
    expect(body.groups.map((g) => g.groupKey)).toEqual([
      REV_C_KEY,
      REV_B_KEY,
      REV_A_KEY,
    ]);
  });

  it("orders by LIVE member count", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(REV_TYPE)}&sort=members&order=desc&limit=100`,
    );
    // The inverse of the revenue order — proving `members` really drives it.
    expect(body.groups.map((g) => g.groupKey)).toEqual([
      REV_C_KEY,
      REV_B_KEY,
      REV_A_KEY,
    ]);
    expect(body.groups.map((g) => g.memberCount)).toEqual([2, 1, 0]);
    // The aggregate-sorted path still carries the per-currency money.
    expect(body.groups.map((g) => g.revenueTotals)).toEqual([
      [],
      [{ currency: "USD", total: 30 }],
      [{ currency: "USD", total: 150 }],
    ]);
  });

  it("orders by name (display name, falling back to key)", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(REV_TYPE)}&sort=name&order=asc&limit=100`,
    );
    // "Alpha-…" < "Beta Ltd" < "Gamma GmbH".
    expect(body.groups.map((g) => g.groupKey)).toEqual([
      REV_A_KEY,
      REV_B_KEY,
      REV_C_KEY,
    ]);
    // The column-sorted path carries both aggregates too.
    expect(body.groups.map((g) => g.revenueTotals)).toEqual([
      [{ currency: "USD", total: 150 }],
      [{ currency: "USD", total: 30 }],
      [],
    ]);
    expect(body.groups.map((g) => g.memberCount)).toEqual([0, 1, 2]);
  });
});

describe("GET /v1/admin/groups — search (Phase 9.1)", () => {
  it("matches the display name, case-insensitively, and narrows total", async () => {
    const body = await listGroups(
      `search=${encodeURIComponent(REV_A_NAME.toLowerCase())}&limit=100`,
    );
    expect(body.total).toBe(1);
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0]?.groupKey).toBe(REV_A_KEY);
    expect(body.groups[0]?.revenueTotals).toEqual([
      { currency: "USD", total: 150 },
    ]);
  });

  it("treats ILIKE metacharacters literally", async () => {
    // Unescaped, `_` is a single-char wildcard and this ALSO matches
    // `…-promoX50`. Escaped, it matches only the group actually named that.
    const body = await listGroups(
      `search=${encodeURIComponent(PROMO_LITERAL_KEY)}&limit=100`,
    );
    expect(body.total).toBe(1);
    expect(body.groups.map((g) => g.groupKey)).toEqual([PROMO_LITERAL_KEY]);

    // Both are findable by a substring that carries no metacharacter, proving
    // the wildcard group really is there to be (wrongly) matched.
    const both = await listGroups(
      `groupType=${encodeURIComponent(PROMO_TYPE)}&limit=100`,
    );
    expect(both.total).toBe(2);
  });

  it("matches the group key", async () => {
    const body = await listGroups(
      `search=${encodeURIComponent(`${RUN}-rev-`)}&limit=100`,
    );
    expect(body.total).toBe(3);
    expect(body.groups.map((g) => g.groupKey).sort()).toEqual(
      [REV_A_KEY, REV_B_KEY, REV_C_KEY].sort(),
    );
  });

  it("composes with groupType and sort", async () => {
    const body = await listGroups(
      `groupType=${encodeURIComponent(REV_TYPE)}&search=${encodeURIComponent(`${RUN}-rev-`)}&sort=revenue&order=desc&limit=2`,
    );
    expect(body.total).toBe(3);
    expect(body.groups.map((g) => g.groupKey)).toEqual([REV_A_KEY, REV_B_KEY]);
  });

  it("returns an empty page when nothing matches", async () => {
    const body = await listGroups(
      `search=${encodeURIComponent(`${RUN}-no-such-group`)}`,
    );
    expect(body.total).toBe(0);
    expect(body.groups).toEqual([]);
  });
});
