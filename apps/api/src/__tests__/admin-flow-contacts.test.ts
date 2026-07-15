/**
 * GET /v1/admin/flow/nodes/{nodeId}/contacts — the drill-down (P5): WHO is at a
 * node.
 *
 * Proves: the admin auth gate; a 404 for an unknown node; the default
 * recent-at-node list (everyone whose last classified event landed here,
 * last-seen first, with the email join + a `stuck` flag + sane `hoursIdle`);
 * the `stuckOnly` slice (only the pile-up past the threshold); the won-stage
 * drill-down (the aggregate's conversion-destination exclusion is overridden so
 * an operator CAN inspect a won stage); the journey node's live enrollment
 * breakdown (and `journey: null` for a non-journey node); the `nodeId`
 * URL-encoding round-trip (node ids carry `:`); and the `limit` cap.
 *
 * Everything is run-scoped (contact ids, event names, journey + funnel + surface
 * ids) so counts stay exact on a shared dev database.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { contacts, journeyStates, userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { days } = await import("@hogsend/core");
const {
  createApp,
  createHogsendClient,
  defineFunnel,
  defineJourney,
  defineSurface,
} = await import("@hogsend/engine");

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

const RUN = `dflow-${Date.now()}`;
const JOURNEY_ID = `${RUN}-journey`;
const FUNNEL_ID = `${RUN}-funnel`;
const SURFACE_ID = `${RUN}docs`;
const SURFACE_PREFIX = `${RUN}.docs.`;
const SURFACE_EVENT = `${RUN}.docs.viewed`;
const ENQUIRY_EVENT = `${RUN}.enquiry_received`;
const SIGNED_EVENT = `${RUN}.contract_signed`;

const SURFACE_NODE = `surface:${SURFACE_ID}`;
const JOURNEY_NODE = `journey:${JOURNEY_ID}`;
const ENQUIRY_NODE = `funnel:${FUNNEL_ID}:enquiry`;
const SIGNED_NODE = `funnel:${FUNNEL_ID}:contract_signed`;

const testJourney = defineJourney({
  meta: {
    id: JOURNEY_ID,
    name: "Drill-down fixture",
    enabled: true,
    trigger: { event: `${RUN}.enrolled` },
    entryLimit: "unlimited",
    suppress: days(0),
  },
  run: async () => {},
});

const testFunnel = defineFunnel({
  id: FUNNEL_ID,
  name: "Drill-down funnel",
  stages: [
    { id: "enquiry", on: ENQUIRY_EVENT },
    { id: "contract_signed", on: SIGNED_EVENT, milestone: "won" },
  ],
});

const testSurface = defineSurface({
  id: SURFACE_ID,
  name: "Docs",
  tier: "acquisition",
  match: { eventPrefix: SURFACE_PREFIX },
});

const container = createHogsendClient({
  journeys: [testJourney],
  funnels: [testFunnel],
  surfaces: [testSurface],
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

const HOUR = 60 * 60 * 1000;
const hoursAgo = (h: number) => new Date(Date.now() - h * HOUR);

// Two fresh contacts at the surface (1h, 2h idle) + one stuck (72h) — the
// last-seen-desc order is FRESH1, FRESH2, STUCK.
const FRESH1 = `${RUN}-fresh1`;
const FRESH2 = `${RUN}-fresh2`;
const STUCK = `${RUN}-stuck`;
// A contact whose last event is the WON stage, 3 days ago — the aggregate map
// excludes won stages from dwell, but the drill-down must still surface it.
const STUCK_WON = `${RUN}-stuck-won`;
// An anonymous-only surface contact (no externalId) — the email join must
// resolve it via anonymousId, exactly like the events feed.
const ANON = `${RUN}-anon`;

type NodeContact = {
  userId: string;
  contactId: string | null;
  email: string | null;
  lastSeenAt: string;
  hoursIdle: number;
  stuck: boolean;
};
type ContactsResponse = {
  node: { id: string; kind: string; name: string; tier: string };
  contacts: NodeContact[];
  journey: {
    journeyId: string;
    counts: {
      active: number;
      waiting: number;
      completed: number;
      failed: number;
      exited: number;
    };
  } | null;
  meta: {
    windowDays: number;
    dwellThresholdHours: number;
    stuckOnly: boolean;
    limit: number;
  };
};

const fetchNode = async (
  nodeId: string,
  query = "",
): Promise<ContactsResponse> => {
  const res = await app.request(
    `/v1/admin/flow/nodes/${encodeURIComponent(nodeId)}/contacts${query}`,
    { headers: AUTH_HEADER },
  );
  expect(res.status).toBe(200);
  return (await res.json()) as ContactsResponse;
};

beforeAll(async () => {
  // Self-healing sweep: a run killed before afterAll strands rows that would
  // skew a later run's counts. Clear ALL dflow litter, not just this run's.
  await db.delete(contacts).where(like(contacts.externalId, "dflow-%"));
  await db.delete(contacts).where(like(contacts.anonymousId, "dflow-%"));
  await db.delete(journeyStates).where(like(journeyStates.userId, "dflow-%"));
  await db.delete(userEvents).where(like(userEvents.userId, "dflow-%"));

  await db.insert(userEvents).values([
    {
      userId: FRESH1,
      event: SURFACE_EVENT,
      source: "web",
      occurredAt: hoursAgo(1),
    },
    {
      userId: FRESH2,
      event: SURFACE_EVENT,
      source: "web",
      occurredAt: hoursAgo(2),
    },
    {
      userId: STUCK,
      event: SURFACE_EVENT,
      source: "web",
      occurredAt: hoursAgo(72),
    },
    {
      userId: ANON,
      event: SURFACE_EVENT,
      source: "web",
      occurredAt: hoursAgo(3),
    },
    // Won-stage occupant, 3 days idle.
    {
      userId: STUCK_WON,
      event: SIGNED_EVENT,
      source: "test",
      occurredAt: hoursAgo(72),
    },
  ]);

  // Contacts rows so email joins resolve. FRESH1/FRESH2/STUCK/STUCK_WON are
  // externalId-keyed; ANON is anonymousId-only (no externalId).
  await db.insert(contacts).values([
    { externalId: FRESH1, email: `${FRESH1}@example.test` },
    { externalId: FRESH2, email: `${FRESH2}@example.test` },
    { externalId: STUCK, email: `${STUCK}@example.test` },
    { externalId: STUCK_WON, email: `${STUCK_WON}@example.test` },
    { anonymousId: ANON, email: `${ANON}@example.test` },
  ]);

  // Journey enrollment breakdown: 2 active, 1 waiting, 1 completed, 1 failed,
  // 1 exited. Live rows (active/waiting) and terminal rows coexist because the
  // journey is `unlimited`; the drill-down reports ALL of them (not just live).
  const jsRow = (
    userId: string,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    userId,
    userEmail: `${userId}@example.test`,
    journeyId: JOURNEY_ID,
    currentNodeId: "start",
    status: status as "active",
    ...extra,
  });
  await db.insert(journeyStates).values([
    jsRow(`${RUN}-j-active-1`, "active"),
    jsRow(`${RUN}-j-active-2`, "active"),
    jsRow(`${RUN}-j-waiting`, "waiting"),
    jsRow(`${RUN}-j-completed`, "completed", { completedAt: hoursAgo(1) }),
    jsRow(`${RUN}-j-failed`, "failed"),
    jsRow(`${RUN}-j-exited`, "exited", { exitedAt: hoursAgo(1) }),
    // A soft-deleted row must NOT be counted.
    jsRow(`${RUN}-j-deleted`, "active", { deletedAt: hoursAgo(1) }),
  ]);
});

afterAll(async () => {
  await db.delete(contacts).where(like(contacts.externalId, `${RUN}%`));
  await db.delete(contacts).where(like(contacts.anonymousId, `${RUN}%`));
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
});

describe("auth + not-found", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request(
      `/v1/admin/flow/nodes/${encodeURIComponent(SURFACE_NODE)}/contacts`,
    );
    expect(res.status).toBe(401);
  });

  it("404s an unknown node with a helpful message", async () => {
    const res = await app.request(
      `/v1/admin/flow/nodes/${encodeURIComponent("surface:no-such-node")}/contacts`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("no-such-node");
  });
});

describe("recent-at-node (default)", () => {
  let flow: ContactsResponse;
  beforeAll(async () => {
    flow = await fetchNode(SURFACE_NODE);
  });

  it("returns the node's identity", () => {
    expect(flow.node).toMatchObject({
      id: SURFACE_NODE,
      kind: "surface",
      name: "Docs",
      tier: "acquisition",
    });
    expect(flow.journey).toBeNull();
    expect(flow.meta).toMatchObject({
      windowDays: 30,
      dwellThresholdHours: 48,
      stuckOnly: false,
      limit: 50,
    });
  });

  it("orders contacts last-seen desc with the email join resolved", () => {
    const ours = flow.contacts.filter((c) => c.userId.startsWith(RUN));
    expect(ours.map((c) => c.userId)).toEqual([FRESH1, FRESH2, ANON, STUCK]);
    expect(ours[0]?.email).toBe(`${FRESH1}@example.test`);
    // ANON resolves via anonymousId, exactly like the events feed.
    expect(ours.find((c) => c.userId === ANON)?.email).toBe(
      `${ANON}@example.test`,
    );
    for (const c of ours) expect(c.contactId).not.toBeNull();
  });

  it("flags stuck correctly and reports sane hoursIdle", () => {
    const fresh = flow.contacts.find((c) => c.userId === FRESH1);
    const stuck = flow.contacts.find((c) => c.userId === STUCK);
    expect(fresh?.stuck).toBe(false);
    expect(fresh?.hoursIdle ?? 0).toBeLessThan(48);
    expect(stuck?.stuck).toBe(true);
    expect(stuck?.hoursIdle ?? 0).toBeGreaterThan(48);
  });
});

describe("stuckOnly", () => {
  it("returns only the pile-up; fresh contacts are absent", async () => {
    const flow = await fetchNode(SURFACE_NODE, "?stuckOnly=true");
    expect(flow.meta.stuckOnly).toBe(true);
    const ours = flow.contacts.filter((c) => c.userId.startsWith(RUN));
    expect(ours.map((c) => c.userId)).toEqual([STUCK]);
    expect(ours[0]?.stuck).toBe(true);
    expect(flow.contacts.some((c) => c.userId === FRESH1)).toBe(false);
  });

  it("surfaces stuck contacts on a WON stage (exclusion overridden)", async () => {
    // The aggregate map excludes conversion destinations from dwell; the
    // drill-down passes excludeNodeIds: [] so a won stage CAN be inspected.
    const flow = await fetchNode(SIGNED_NODE, "?stuckOnly=true");
    const ours = flow.contacts.filter((c) => c.userId.startsWith(RUN));
    expect(ours.map((c) => c.userId)).toEqual([STUCK_WON]);
    expect(ours[0]?.stuck).toBe(true);
  });
});

describe("journey nodes", () => {
  it("returns the live enrollment breakdown", async () => {
    const flow = await fetchNode(JOURNEY_NODE);
    expect(flow.node.kind).toBe("journey");
    expect(flow.journey?.journeyId).toBe(JOURNEY_ID);
    // The soft-deleted active row is excluded, so active is 2 not 3.
    expect(flow.journey?.counts).toEqual({
      active: 2,
      waiting: 1,
      completed: 1,
      failed: 1,
      exited: 1,
    });
  });

  it("leaves journey null for a non-journey node", async () => {
    const flow = await fetchNode(ENQUIRY_NODE);
    expect(flow.node.kind).toBe("funnelStage");
    expect(flow.journey).toBeNull();
  });
});

describe("nodeId encoding + limit", () => {
  it("round-trips a %3A-encoded funnel stage node id", async () => {
    // funnel:<id>:contract_signed — the colons arrive percent-encoded and must
    // decode to the real node id.
    const encoded = `funnel%3A${FUNNEL_ID}%3Acontract_signed`;
    const res = await app.request(
      `/v1/admin/flow/nodes/${encoded}/contacts?stuckOnly=true`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(200);
    const flow = (await res.json()) as ContactsResponse;
    expect(flow.node.id).toBe(SIGNED_NODE);
    expect(flow.contacts.some((c) => c.userId === STUCK_WON)).toBe(true);
  });

  it("respects the limit cap", async () => {
    // Four of our contacts are at the surface node; limit=2 returns the two
    // freshest.
    const flow = await fetchNode(SURFACE_NODE, "?limit=2");
    expect(flow.meta.limit).toBe(2);
    expect(flow.contacts.length).toBe(2);
    // Still last-seen-desc, so the two freshest.
    expect(flow.contacts.map((c) => c.userId)).toEqual([FRESH1, FRESH2]);
  });
});

describe("last-classified-node semantics + the lookback floor (P5 review pins)", () => {
  // A walker whose path is surface → enquiry: their LAST node is the enquiry
  // stage, so the surface drill-down must NOT list them (visiting a node is
  // not being AT it), while the enquiry drill-down must.
  const WALKER = `${RUN}-walker`;
  // Idle 10 days at the enquiry stage — outside a 7d display window, but the
  // drill-down lookback floors at 30d (exactly like the map's dwell badge),
  // so the panel must still surface them.
  const LONG_STUCK = `${RUN}-long-stuck`;

  beforeAll(async () => {
    await db.insert(userEvents).values([
      {
        userId: WALKER,
        event: SURFACE_EVENT,
        source: "test",
        occurredAt: hoursAgo(5),
      },
      {
        userId: WALKER,
        event: ENQUIRY_EVENT,
        source: "test",
        occurredAt: hoursAgo(4),
      },
      {
        userId: LONG_STUCK,
        event: ENQUIRY_EVENT,
        source: "test",
        occurredAt: hoursAgo(240),
      },
    ]);
  });

  it("lists a contact only at their LAST classified node", async () => {
    const surface = await fetchNode(SURFACE_NODE);
    expect(surface.contacts.some((c) => c.userId === WALKER)).toBe(false);
    const enquiry = await fetchNode(ENQUIRY_NODE);
    expect(enquiry.contacts.some((c) => c.userId === WALKER)).toBe(true);
  });

  it("floors the lookback so the badge's long-stuck contacts stay visible", async () => {
    // windowDays=1 is what Studio's "Last 24 hours" sends — the 10-day-idle
    // contact must STILL appear (both modes), or clicking a card's stuck
    // badge would open an empty panel.
    const recent = await fetchNode(ENQUIRY_NODE, "?windowDays=1");
    expect(recent.contacts.some((c) => c.userId === LONG_STUCK)).toBe(true);
    const stuck = await fetchNode(ENQUIRY_NODE, "?windowDays=1&stuckOnly=true");
    const row = stuck.contacts.find((c) => c.userId === LONG_STUCK);
    expect(row?.stuck).toBe(true);
    expect(row?.hoursIdle ?? 0).toBeGreaterThan(200);
  });

  it("rejects an out-of-range limit", async () => {
    const res = await app.request(
      `/v1/admin/flow/nodes/${encodeURIComponent(SURFACE_NODE)}/contacts?limit=201`,
      { headers: AUTH_HEADER },
    );
    expect(res.status).toBe(400);
  });
});
