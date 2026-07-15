/**
 * GET /v1/admin/flow?mode=raw — the control-room flow map's escape hatch: no
 * registry, just the loudest event-name prefixes. (The curated default is
 * covered by `admin-flow-curated.test.ts`.) Proves: the admin
 * auth gate, the window bounds, the prefix classifier (`docs.opened` → `docs`),
 * the same-node collapse (consecutive docs events are ONE node, never a
 * self-loop), per-edge transition + distinct-contact counts, node totals for a
 * contact who never transitions, and the honest `meta.effectiveWindowDays`.
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { userEvents } = await import("@hogsend/db");
const { like } = await import("drizzle-orm");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { journeys } = await import("../journeys/index.js");
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

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
  journeys,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = { Authorization: `Bearer ${process.env.ADMIN_API_KEY}` };

// Run-scoped prefix so a shared docker DB (littered with other suites' rows)
// never collides; everything created here is swept in afterAll.
const RUN = `aflow-${Date.now()}`;
const SITE = `${RUN}site`;
const DOCS = `${RUN}docs`;
const COURSE = `${RUN}course`;

/**
 * Raw mode keeps only the top 15 prefixes BY VOLUME, and the shared dev DB
 * carries leftovers from other suites (~90 events/prefix). Each of our
 * prefixes therefore gets a dedicated padding contact firing PAD same-prefix
 * events, which clears the cut without touching the edge counts: a run of
 * same-node events collapses, so a contact who only ever hits one prefix can
 * never produce a transition. The padding IS counted in the node totals below.
 */
const PAD = 200;

type FlowNode = {
  id: string;
  kind: string;
  name: string;
  tier: string;
  contacts: number;
  events: number;
  live: number | null;
  heat: {
    conversionRate: number | null;
    attributedRevenue: { amount: number; currency: string }[];
    directRevenue: { amount: number; currency: string }[];
  } | null;
  dwell: {
    stuckContacts: number;
    thresholdHours: number;
    oldestLastSeenAt: string | null;
    p50HoursStuck: number | null;
  } | null;
};
type FlowEdge = {
  from: string;
  to: string;
  transitions: number;
  contacts: number;
  lanes: Record<string, number> | null;
};
type FlowResponse = {
  window: { days: number; from: string; to: string };
  nodes: FlowNode[];
  edges: FlowEdge[];
  lanes: { id: string; count: number }[];
  meta: {
    truncated: boolean;
    effectiveWindowDays: number;
    generatedAt: string;
  };
};

let flow: FlowResponse;

const base = Date.now() - 60 * 60 * 1000;
/** Distinct, ordered timestamps — LAG orders by (occurred_at, id). */
const at = (step: number) => new Date(base + step * 1000);

beforeAll(async () => {
  // Self-healing sweep: a run killed before its afterAll strands ~600 padded
  // events that beat-or-tie LATER runs in the top-15 volume cut (older ids
  // win the count tie), failing every subsequent run for a day. Clear ALL
  // aflow litter, not just this run's.
  await db.delete(userEvents).where(like(userEvents.userId, "aflow-%"));

  const rows: {
    userId: string;
    event: string;
    source: string;
    occurredAt: Date;
  }[] = [];

  // Two contacts walk the whole path. `docs.opened` → `docs.read` share the
  // `docs` prefix, so they MUST collapse into one docs node (no self-loop).
  for (const user of [`${RUN}-c1`, `${RUN}-c2`]) {
    const walk = [
      `${SITE}.viewed`,
      `${DOCS}.opened`,
      `${DOCS}.read`,
      `${COURSE}.started`,
    ];
    walk.forEach((event, i) => {
      rows.push({ userId: user, event, source: "test", occurredAt: at(i) });
    });
  }

  // A third contact never leaves the site — node totals only, no edges.
  rows.push({
    userId: `${RUN}-c3`,
    event: `${SITE}.viewed`,
    source: "test",
    occurredAt: at(0),
  });

  // Volume padding (see PAD above) — one dedicated contact per prefix.
  for (const prefix of [SITE, DOCS, COURSE]) {
    for (let i = 0; i < PAD; i++) {
      rows.push({
        userId: `${RUN}-pad-${prefix}`,
        event: `${prefix}.pad`,
        source: "test",
        occurredAt: at(i),
      });
    }
  }

  await db.insert(userEvents).values(rows);

  // `mode` is EXPLICIT here: since P2 the route defaults to `curated` (the
  // registry-backed classifier). Raw is the escape hatch this suite covers.
  const res = await app.request("/v1/admin/flow?windowDays=1&mode=raw", {
    headers: AUTH_HEADER,
  });
  expect(res.status).toBe(200);
  flow = (await res.json()) as FlowResponse;
});

afterAll(async () => {
  await db.delete(userEvents).where(like(userEvents.userId, `${RUN}%`));
});

const nodeOf = (id: string) => flow.nodes.find((n) => n.id === id);
const edgeOf = (from: string, to: string) =>
  flow.edges.find((e) => e.from === from && e.to === to);

describe("GET /v1/admin/flow", () => {
  it("rejects an unauthenticated request", async () => {
    const res = await app.request("/v1/admin/flow");
    expect(res.status).toBe(401);
  });

  it("builds edges from the classified transition sequence", () => {
    expect(edgeOf(SITE, DOCS)).toMatchObject({ transitions: 2, contacts: 2 });
    expect(edgeOf(DOCS, COURSE)).toMatchObject({ transitions: 2, contacts: 2 });
    // Placeholder for the P3 lane split — declared, null for now.
    expect(edgeOf(SITE, DOCS)?.lanes).toBeNull();
  });

  it("collapses consecutive same-node events instead of drawing a self-loop", () => {
    expect(edgeOf(DOCS, DOCS)).toBeUndefined();
    expect(flow.edges.some((e) => e.from === e.to)).toBe(false);
  });

  it("reports node totals, including a contact who never transitions", () => {
    // 2 walkers + the site-only contact + the padding contact; 3 walk events
    // + PAD padding events.
    const site = nodeOf(SITE);
    expect(site).toMatchObject({
      kind: "surface",
      name: SITE,
      contacts: 4,
      events: 3 + PAD,
      live: null,
      heat: null,
      dwell: null,
    });
    // Raw-mode nodes are unregistered — no lifecycle badge to claim.
    expect(site?.tier).toBeUndefined();
    // The site-only contact contributes to the site node but to no edge.
    expect(flow.edges.some((e) => e.to === SITE)).toBe(false);

    // 2 walkers × 2 docs events (opened + read) + the padding contact.
    expect(nodeOf(DOCS)).toMatchObject({ contacts: 3, events: 4 + PAD });
    expect(nodeOf(COURSE)).toMatchObject({ contacts: 3, events: 2 + PAD });
  });

  it("echoes the window and reports the effective one", () => {
    expect(flow.window.days).toBe(1);
    expect(flow.meta.effectiveWindowDays).toBe(1);
    expect(flow.meta.truncated).toBe(false);
    expect(Date.parse(flow.meta.generatedAt)).not.toBeNaN();
    expect(Date.parse(flow.window.from)).toBeLessThan(
      Date.parse(flow.window.to),
    );
  });

  it("rejects an out-of-range windowDays", async () => {
    const low = await app.request("/v1/admin/flow?windowDays=0", {
      headers: AUTH_HEADER,
    });
    expect(low.status).toBe(400);

    const high = await app.request("/v1/admin/flow?windowDays=91", {
      headers: AUTH_HEADER,
    });
    expect(high.status).toBe(400);
  });
});
