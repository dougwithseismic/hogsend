/**
 * Journey Blueprints phase 3 — the admin CRUD + lifecycle surface
 * (spec §9/§14 phase 3), following the admin-journeys harness: `app.request()`
 * directly against the Hono app, real Postgres for `journey_blueprints` /
 * `journey_states`, Hatchet injected via the container override seam.
 *
 * Proves: create validates the graph BEFORE writing (structured 422 issues,
 * incl. the engine-side template/connector registry checks core cannot do),
 * PATCH re-validates + bumps `version` only on graph changes, enable/disable
 * transitions (enable re-validates the STORED graph against the CURRENT
 * registries), promote-to-code (spec §11 — stamps `promotedAt`/
 * `promotedToJourneyId` + disables in one update; re-enable refused
 * thereafter), the standalone no-id `/validate` dry-run loop, and the graph
 * route returning the byte-identical shape of the code-journey graph route so
 * Studio's flow view renders either unchanged (spec §3).
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const {
  createApp,
  createHogsendClient,
  enableBlueprint,
  promoteBlueprint,
  updateBlueprint,
} = await import("@hogsend/engine");
const { journeyBlueprints, journeyStates } = await import("@hogsend/db");
const { eq, like } = await import("drizzle-orm");
const { journeys } = await import("../journeys/index.js");
const { conversions } = await import("../conversions/index.js");
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
  runs: {
    cancel: vi.fn(),
    get: vi.fn(),
  },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  conversions,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container);
const { db } = container;

const AUTH_HEADER = {
  Authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
};
const JSON_HEADERS = { ...AUTH_HEADER, "Content-Type": "application/json" };

// Run-scoped id prefix so parallel test files against the shared docker DB
// never collide; everything it created is swept in afterAll.
const RUN = `abp-${Date.now()}`;
const STATE_USER = `${RUN}-user`;

afterAll(async () => {
  await db.delete(journeyStates).where(eq(journeyStates.userId, STATE_USER));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}%`));
});

/** Valid execution-tier graph: enroll → sleep → decision → send → end. */
function nudgeGraph(blueprintId: string) {
  return {
    journeyId: blueprintId,
    nodes: [
      { id: "start", type: "start", title: `${RUN}.enroll` },
      {
        id: "sleep-3d",
        type: "sleep",
        title: "Wait 3 days",
        meta: { duration: { hours: 72 } },
      },
      {
        id: "check-activated",
        type: "decision",
        title: "Activated?",
        meta: {
          conditions: [
            {
              type: "property",
              property: "activated",
              operator: "eq",
              value: true,
            },
          ],
        },
      },
      {
        id: "send-nudge",
        type: "send",
        title: "Send activation nudge",
        meta: { template: "welcome" },
      },
      { id: "end-ok", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "sleep-3d" },
      { id: "e2", source: "sleep-3d", target: "check-activated" },
      {
        id: "e3",
        source: "check-activated",
        target: "end-ok",
        kind: "conditional-true",
      },
      {
        id: "e4",
        source: "check-activated",
        target: "send-nudge",
        kind: "conditional-false",
      },
      { id: "e5", source: "send-nudge", target: "end-ok" },
    ],
  };
}

/** Minimal graph with a trigger node: enroll → trigger(event) → end. */
function triggerGraph(blueprintId: string, event: string) {
  return {
    journeyId: blueprintId,
    nodes: [
      { id: "start", type: "start", title: `${RUN}.enroll` },
      {
        id: "fire-event",
        type: "trigger",
        title: "Fire event",
        meta: { event },
      },
      { id: "end-ok", type: "end-completed", title: "Done" },
    ],
    edges: [
      { id: "e1", source: "start", target: "fire-event" },
      { id: "e2", source: "fire-event", target: "end-ok" },
    ],
  };
}

function createBody(
  blueprintId: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    name: "Activation nudge",
    description: "Nudge users who did not activate",
    triggerEvent: `${RUN}.enroll`,
    entryLimit: "once",
    suppress: {},
    graph: nudgeGraph(blueprintId),
    source: "api",
    createdBy: "vitest",
    ...overrides,
  };
}

async function createBlueprint(
  blueprintId: string,
  overrides: Record<string, unknown> = {},
) {
  return app.request("/v1/admin/blueprints", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(createBody(blueprintId, overrides)),
  });
}

describe("POST /v1/admin/blueprints", () => {
  it("returns 401 without auth", async () => {
    const res = await app.request("/v1/admin/blueprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createBody(`${RUN}-unauthed`)),
    });
    expect(res.status).toBe(401);
  });

  it("creates a blueprint from a valid graph (draft by default)", async () => {
    const id = `${RUN}-create`;
    const res = await createBlueprint(id);
    expect(res.status).toBe(201);

    const body = await res.json();
    expect(body.blueprint.id).toBe(id); // id IS graph.journeyId
    expect(body.blueprint.status).toBe("draft");
    expect(body.blueprint.version).toBe(1);
    expect(body.blueprint.triggerEvent).toBe(`${RUN}.enroll`);
    expect(body.blueprint.entryLimit).toBe("once");
    expect(body.blueprint.source).toBe("api");
    expect(body.blueprint.createdBy).toBe("vitest");
    expect(body.blueprint.graph.journeyId).toBe(id);
    expect(body.blueprint.graph.nodes).toHaveLength(5);
    expect(body.blueprint.promotedAt).toBeNull();
    expect(body.blueprint.createdAt).toBeTruthy();
  });

  it("may create directly enabled — no forced staging step", async () => {
    const res = await createBlueprint(`${RUN}-live`, { status: "enabled" });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.blueprint.status).toBe("enabled");
  });

  it("rejects an invalid graph with structured issues and writes nothing", async () => {
    const id = `${RUN}-invalid`;
    const graph = nudgeGraph(id);
    // Break it twice: strip the sleep's required duration AND orphan a node.
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[1] as any).meta = {};
    graph.nodes.push({
      id: "island",
      type: "checkpoint",
      title: "Unreachable",
      // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    } as any);

    const res = await createBlueprint(id, { graph });
    expect(res.status).toBe(422);

    const body = await res.json();
    expect(body.error).toBeTruthy();
    expect(body.issues.length).toBeGreaterThan(0);
    // Every issue is structured: code + message + path, naming the node.
    for (const issue of body.issues) {
      expect(issue.code).toBeTruthy();
      expect(issue.message).toBeTruthy();
      expect(issue.path).toBeInstanceOf(Array);
    }
    const missingDuration = body.issues.find(
      (i: { nodeId?: string }) => i.nodeId === "sleep-3d",
    );
    expect(missingDuration).toBeDefined();

    // Nothing was saved.
    const getRes = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(404);
  });

  it("rejects a send of an unregistered template (registry check)", async () => {
    const id = `${RUN}-badtpl`;
    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[3] as any).meta = { template: "not-a-real-template" };

    const res = await createBlueprint(id, { graph });
    expect(res.status).toBe(422);
    const body = await res.json();
    const issue = body.issues.find(
      (i: { code: string }) => i.code === "unknown_template",
    );
    expect(issue).toBeDefined();
    expect(issue.nodeId).toBe("send-nudge");
    expect(issue.message).toContain("not-a-real-template");
  });

  it("rejects an unregistered connector action (registry check)", async () => {
    const id = `${RUN}-badconn`;
    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: swap send for a connector node
    (graph.nodes[3] as any) = {
      id: "send-nudge",
      type: "connector",
      title: "Ping Discord",
      meta: { connectorId: "discord", action: "noSuchAction" },
    };

    const res = await createBlueprint(id, { graph });
    expect(res.status).toBe(422);
    const body = await res.json();
    const issue = body.issues.find(
      (i: { code: string }) => i.code === "unknown_connector_action",
    );
    expect(issue).toBeDefined();
    expect(issue.message).toContain("discord:noSuchAction");
  });

  it("422s a reserved-namespace triggerEvent — engine events cannot trigger a blueprint", async () => {
    const id = `${RUN}-reserved-trigger`;
    const res = await createBlueprint(id, { triggerEvent: "email.opened" });
    expect(res.status).toBe(422);
    const body = await res.json();
    const issue = body.issues.find(
      (i: { code: string }) => i.code === "reserved_event",
    );
    expect(issue).toBeDefined();
    expect(issue.path).toEqual(["triggerEvent"]);

    // Nothing was saved.
    const getRes = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(404);
  });

  it("422s a trigger NODE that forges a reserved-namespace event", async () => {
    const id = `${RUN}-reserved-node`;
    const res = await createBlueprint(id, {
      graph: triggerGraph(id, "journey:completed"),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    const issue = body.issues.find(
      (i: { code: string }) => i.code === "reserved_event",
    );
    expect(issue).toBeDefined();
    expect(issue.nodeId).toBe("fire-event");
  });

  it("400s an empty {} entryPeriod — it would silently disable once_per_period", async () => {
    const id = `${RUN}-empty-period`;
    const res = await createBlueprint(id, {
      entryLimit: "once_per_period",
      entryPeriod: {},
    });
    expect(res.status).toBe(400);

    // Omitting entryPeriod stays legal (checkEntryLimit defaults to 24h).
    const omitted = await createBlueprint(id, {
      entryLimit: "once_per_period",
    });
    expect(omitted.status).toBe(201);
  });

  it("400s a zero-value entryPeriod — durationToMs === 0 degrades once_per_period to unlimited", async () => {
    // Key presence alone is not enough: { hours: 0 } / { seconds: 0 } still
    // yields a zero cutoff, so the refine must reject non-positive durations.
    for (const entryPeriod of [
      { hours: 0 },
      { seconds: 0 },
      { hours: 0, minutes: 0, seconds: 0 },
    ]) {
      const res = await createBlueprint(`${RUN}-zero-period`, {
        entryLimit: "once_per_period",
        entryPeriod,
      });
      expect(res.status).toBe(400);
    }

    // A positive partial-zero duration stays legal.
    const ok = await createBlueprint(`${RUN}-pos-period`, {
      entryLimit: "once_per_period",
      entryPeriod: { hours: 0, minutes: 30 },
    });
    expect(ok.status).toBe(201);
  });

  it("409s on a duplicate blueprint id", async () => {
    const id = `${RUN}-dupe`;
    expect((await createBlueprint(id)).status).toBe(201);
    const res = await createBlueprint(id);
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("conflict");
  });

  it("409s when the id collides with a registered code journey", async () => {
    const res = await createBlueprint("activation-welcome", {
      triggerEvent: "user.signed_up",
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("code journey");
    expect(body.code).toBe("conflict");
  });
});

describe("POST /v1/admin/blueprints/validate", () => {
  it("returns valid: true with no issues for a good graph (no write)", async () => {
    const id = `${RUN}-dryrun`;
    const res = await app.request("/v1/admin/blueprints/validate", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph: nudgeGraph(id) }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ valid: true, issues: [] });

    // Dry-run: nothing was created.
    const getRes = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    expect(getRes.status).toBe(404);
  });

  it("returns the structured issue list for a bad graph — 200, not an error", async () => {
    const graph = nudgeGraph(`${RUN}-dryrun-bad`);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[3] as any).meta = { template: "not-a-real-template" };
    graph.edges.push({
      id: "e-cycle",
      source: "end-ok",
      target: "start",
    });

    const res = await app.request("/v1/admin/blueprints/validate", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    const codes = body.issues.map((i: { code: string }) => i.code);
    expect(codes).toContain("unknown_template");
    expect(codes).toContain("cyclic_graph");
    expect(codes).toContain("terminal_node_has_outgoing_edges");
  });

  it("reports structured issues even for a non-object graph", async () => {
    const res = await app.request("/v1/admin/blueprints/validate", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph: "not a graph" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.valid).toBe(false);
    expect(body.issues.length).toBeGreaterThan(0);
  });
});

describe("GET /v1/admin/blueprints (+ /{id})", () => {
  it("lists blueprints with counts and without the graph blob", async () => {
    const id = `${RUN}-list`;
    expect((await createBlueprint(id)).status).toBe(201);

    const res = await app.request("/v1/admin/blueprints?limit=100", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBeGreaterThan(0);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);

    const item = body.blueprints.find((b: { id: string }) => b.id === id);
    expect(item).toBeDefined();
    expect(item.counts).toEqual({
      active: 0,
      waiting: 0,
      completed: 0,
      failed: 0,
      exited: 0,
    });
    expect(item.graph).toBeUndefined();
  });

  it("filters by status", async () => {
    const res = await app.request("/v1/admin/blueprints?status=enabled", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    for (const bp of body.blueprints) {
      expect(bp.status).toBe("enabled");
    }
  });

  it("returns blueprint detail with graph, counts and recentStates", async () => {
    const id = `${RUN}-detail`;
    expect((await createBlueprint(id)).status).toBe(201);

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.id).toBe(id);
    expect(body.blueprint.graph.journeyId).toBe(id);
    expect(body.blueprint.counts).toBeDefined();
    expect(body.blueprint.recentStates).toBeInstanceOf(Array);
  });

  it("404s for an unknown blueprint", async () => {
    const res = await app.request("/v1/admin/blueprints/nonexistent", {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /v1/admin/blueprints/:id", () => {
  it("404s for an unknown blueprint", async () => {
    const res = await app.request("/v1/admin/blueprints/nonexistent", {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "New name" }),
    });
    expect(res.status).toBe(404);
  });

  it("does NOT bump version on a metadata-only edit", async () => {
    const id = `${RUN}-patch-meta`;
    expect((await createBlueprint(id)).status).toBe(201);

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        name: "Renamed",
        description: "Updated description",
        triggerWhere: [
          { type: "property", property: "plan", operator: "eq", value: "pro" },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.name).toBe("Renamed");
    expect(body.blueprint.description).toBe("Updated description");
    expect(body.blueprint.triggerWhere).toHaveLength(1);
    expect(body.blueprint.version).toBe(1);
  });

  it("bumps version by 1 when the graph changes (re-validated)", async () => {
    const id = `${RUN}-patch-graph`;
    expect((await createBlueprint(id)).status).toBe(201);

    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: edit the sleep duration
    (graph.nodes[1] as any).meta = { duration: { hours: 24 } };

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.version).toBe(2);
    const sleep = body.blueprint.graph.nodes.find(
      (n: { id: string }) => n.id === "sleep-3d",
    );
    expect(sleep.meta.duration).toEqual({ hours: 24 });
  });

  it("422s patching triggerEvent into a reserved namespace, leaving the row untouched", async () => {
    const id = `${RUN}-patch-reserved`;
    expect((await createBlueprint(id)).status).toBe(201);

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ triggerEvent: "journey:completed" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues[0]).toMatchObject({
      code: "reserved_event",
      path: ["triggerEvent"],
    });

    const detail = await (
      await app.request(`/v1/admin/blueprints/${id}`, { headers: AUTH_HEADER })
    ).json();
    expect(detail.blueprint.triggerEvent).toBe(`${RUN}.enroll`);
  });

  it("rejects an invalid graph with 422 and leaves the row untouched", async () => {
    const id = `${RUN}-patch-bad`;
    expect((await createBlueprint(id)).status).toBe(201);

    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[1] as any).meta = {};

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph, name: "Should not apply" }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues.length).toBeGreaterThan(0);

    // The whole PATCH was rejected — version AND name unchanged.
    const getRes = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    const detail = await getRes.json();
    expect(detail.blueprint.version).toBe(1);
    expect(detail.blueprint.name).toBe("Activation nudge");
  });

  it("rejects a graph whose journeyId differs from the blueprint id", async () => {
    const id = `${RUN}-patch-mismatch`;
    expect((await createBlueprint(id)).status).toBe(201);

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph: nudgeGraph(`${RUN}-other-id`) }),
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issues[0].code).toBe("journey_id_mismatch");
  });

  it("rejects a graph edit while an enrollment is active or waiting (409, version unchanged)", async () => {
    const id = `${RUN}-patch-inflight`;
    expect((await createBlueprint(id)).status).toBe(201);

    // A run parked mid-graph — the exact scenario a graph edit would
    // desync (Hatchet's positional replay journal for the suspended sleep).
    await db.insert(journeyStates).values({
      userId: STATE_USER,
      userEmail: `${STATE_USER}@example.com`,
      journeyId: id,
      currentNodeId: "sleep-3d",
      status: "waiting",
    });

    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: edit the sleep duration
    (graph.nodes[1] as any).meta = { duration: { hours: 24 } };

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph }),
    });
    expect(res.status).toBe(409);
    // The 409 body carries the machine-readable service code (not just a message).
    expect((await res.json()).code).toBe("in_flight");

    const getRes = await app.request(`/v1/admin/blueprints/${id}`, {
      headers: AUTH_HEADER,
    });
    const detail = await getRes.json();
    expect(detail.blueprint.version).toBe(1);
  });

  it("still allows a metadata-only edit while an enrollment is active or waiting", async () => {
    const id = `${RUN}-patch-inflight-meta`;
    expect((await createBlueprint(id)).status).toBe(201);

    await db.insert(journeyStates).values({
      userId: STATE_USER,
      userEmail: `${STATE_USER}@example.com`,
      journeyId: id,
      currentNodeId: "sleep-3d",
      status: "active",
    });

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ description: "Still fine to edit metadata" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.description).toBe("Still fine to edit metadata");
    expect(body.blueprint.version).toBe(1);
  });

  it("allows a graph edit again once the enrollment is no longer active/waiting", async () => {
    const id = `${RUN}-patch-drained`;
    expect((await createBlueprint(id)).status).toBe(201);

    const [state] = await db
      .insert(journeyStates)
      .values({
        userId: STATE_USER,
        userEmail: `${STATE_USER}@example.com`,
        journeyId: id,
        currentNodeId: "sleep-3d",
        status: "waiting",
      })
      .returning();
    if (!state) throw new Error("insert returned no row");
    await db
      .update(journeyStates)
      .set({ status: "completed" })
      .where(eq(journeyStates.id, state.id));

    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: edit the sleep duration
    (graph.nodes[1] as any).meta = { duration: { hours: 24 } };

    const res = await app.request(`/v1/admin/blueprints/${id}`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ graph }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.version).toBe(2);
  });
});

describe("POST /v1/admin/blueprints/:id/enable + /disable", () => {
  it("404s for an unknown blueprint", async () => {
    for (const action of ["enable", "disable"]) {
      const res = await app.request(
        `/v1/admin/blueprints/nonexistent/${action}`,
        { method: "POST", headers: AUTH_HEADER },
      );
      expect(res.status).toBe(404);
    }
  });

  it("transitions draft → enabled → disabled → enabled", async () => {
    const id = `${RUN}-lifecycle`;
    expect((await createBlueprint(id)).status).toBe(201);

    const enableRes = await app.request(`/v1/admin/blueprints/${id}/enable`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(enableRes.status).toBe(200);
    expect((await enableRes.json()).blueprint.status).toBe("enabled");

    const disableRes = await app.request(`/v1/admin/blueprints/${id}/disable`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(disableRes.status).toBe(200);
    expect((await disableRes.json()).blueprint.status).toBe("disabled");

    // Re-enable (also proves enable is not draft-only) — and idempotence.
    for (let i = 0; i < 2; i++) {
      const res = await app.request(`/v1/admin/blueprints/${id}/enable`, {
        method: "POST",
        headers: AUTH_HEADER,
      });
      expect(res.status).toBe(200);
      expect((await res.json()).blueprint.status).toBe("enabled");
    }
  });

  it("refuses to enable a blueprint whose stored graph no longer validates", async () => {
    const id = `${RUN}-stale`;
    // Inserted directly (bypassing the route) with a template the registry
    // does not know — models registry drift after save.
    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately stale fixture
    (graph.nodes[3] as any).meta = { template: "unregistered-since-save" };
    await db.insert(journeyBlueprints).values({
      id,
      name: "Stale",
      status: "draft",
      triggerEvent: `${RUN}.enroll`,
      entryLimit: "once",
      suppress: {},
      graph:
        graph as unknown as (typeof journeyBlueprints.$inferInsert)["graph"],
      source: "api",
    });

    const res = await app.request(`/v1/admin/blueprints/${id}/enable`, {
      method: "POST",
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(
      body.issues.some((i: { code: string }) => i.code === "unknown_template"),
    ).toBe(true);

    // Still draft.
    const detail = await (
      await app.request(`/v1/admin/blueprints/${id}`, { headers: AUTH_HEADER })
    ).json();
    expect(detail.blueprint.status).toBe("draft");
  });

  it("re-validates the stored graph via POST /:id/validate (dry-run)", async () => {
    const okRes = await app.request(
      `/v1/admin/blueprints/${RUN}-lifecycle/validate`,
      { method: "POST", headers: AUTH_HEADER },
    );
    expect(okRes.status).toBe(200);
    expect(await okRes.json()).toEqual({ valid: true, issues: [] });

    const staleRes = await app.request(
      `/v1/admin/blueprints/${RUN}-stale/validate`,
      { method: "POST", headers: AUTH_HEADER },
    );
    expect(staleRes.status).toBe(200);
    const staleBody = await staleRes.json();
    expect(staleBody.valid).toBe(false);
    expect(
      staleBody.issues.some(
        (i: { code: string }) => i.code === "unknown_template",
      ),
    ).toBe(true);
  });
});

describe("POST /v1/admin/blueprints/:id/promote", () => {
  it("404s for an unknown blueprint", async () => {
    const res = await app.request("/v1/admin/blueprints/nonexistent/promote", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ journeyId: "some-journey" }),
    });
    expect(res.status).toBe(404);
  });

  it("promotes an enabled blueprint: stamps promotion fields and disables it", async () => {
    const id = `${RUN}-promote`;
    expect((await createBlueprint(id, { status: "enabled" })).status).toBe(201);

    const res = await app.request(`/v1/admin/blueprints/${id}/promote`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ journeyId: `${RUN}-promoted-code` }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint.status).toBe("disabled");
    expect(body.blueprint.promotedAt).toBeTruthy();
    expect(body.blueprint.promotedToJourneyId).toBe(`${RUN}-promoted-code`);

    // The detail surface reflects the same transition.
    const detail = await (
      await app.request(`/v1/admin/blueprints/${id}`, { headers: AUTH_HEADER })
    ).json();
    expect(detail.blueprint.status).toBe("disabled");
    expect(detail.blueprint.promotedAt).toBeTruthy();
    expect(detail.blueprint.promotedToJourneyId).toBe(`${RUN}-promoted-code`);
  });

  it("409s when promoting the same blueprint again (first promotion stands)", async () => {
    const res = await app.request(
      `/v1/admin/blueprints/${RUN}-promote/promote`,
      {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ journeyId: "another-journey" }),
      },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("already promoted");
    expect(body.error).toContain(`${RUN}-promoted-code`);
    expect(body.code).toBe("already_promoted");

    // The original promotion target was not overwritten.
    const detail = await (
      await app.request(`/v1/admin/blueprints/${RUN}-promote`, {
        headers: AUTH_HEADER,
      })
    ).json();
    expect(detail.blueprint.promotedToJourneyId).toBe(`${RUN}-promoted-code`);
  });

  it("still refuses to re-enable a promoted blueprint (409)", async () => {
    const res = await app.request(
      `/v1/admin/blueprints/${RUN}-promote/enable`,
      { method: "POST", headers: AUTH_HEADER },
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("source of truth");
    expect(body.code).toBe("promoted");
  });

  it("refuses to PATCH a promoted blueprint (409) — the graph stays frozen", async () => {
    const res = await app.request(`/v1/admin/blueprints/${RUN}-promote`, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ name: "Renamed after promotion" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("frozen");
    expect(body.code).toBe("promoted");

    // Not just the response — nothing was actually written.
    const detail = await (
      await app.request(`/v1/admin/blueprints/${RUN}-promote`, {
        headers: AUTH_HEADER,
      })
    ).json();
    expect(detail.blueprint.name).not.toBe("Renamed after promotion");
  });

  it("rejects a direct updateBlueprint on a promoted blueprint (structured 'promoted', both paths)", async () => {
    // Reuse the `${RUN}-promote` row promoted earlier in this describe.
    const metaEdit = await updateBlueprint({
      container,
      id: `${RUN}-promote`,
      patch: { name: "Direct rename attempt" },
    });
    expect(metaEdit.ok).toBe(false);
    if (metaEdit.ok) throw new Error("expected metadata update to be refused");
    expect(metaEdit.code).toBe("promoted");

    // A graph edit is frozen the same way — a promoted blueprint is read-only.
    const graphEdit = await updateBlueprint({
      container,
      id: `${RUN}-promote`,
      patch: { graph: nudgeGraph(`${RUN}-promote`) },
    });
    expect(graphEdit.ok).toBe(false);
    if (graphEdit.ok) throw new Error("expected graph update to be refused");
    expect(graphEdit.code).toBe("promoted");
  });
});

describe("blueprint service guards — enable/update races (direct calls)", () => {
  it("refuses to re-enable a promoted blueprint (direct promote→enable sequence)", async () => {
    const id = `${RUN}-svc-enable-promoted`;
    expect((await createBlueprint(id, { status: "enabled" })).status).toBe(201);

    const promoted = await promoteBlueprint({
      container,
      id,
      journeyId: `${id}-code`,
    });
    expect(promoted.ok).toBe(true);

    // The blind status='enabled' write is guarded on promotedAt IS NULL, so a
    // promoted row can never be re-enabled even by calling the service directly.
    const enabled = await enableBlueprint({ container, id });
    expect(enabled.ok).toBe(false);
    if (enabled.ok) throw new Error("expected enable to be refused");
    expect(enabled.code).toBe("promoted");
  });

  it("returns exactly one version_conflict when two graph edits race", async () => {
    const id = `${RUN}-svc-version-race`;
    expect((await createBlueprint(id)).status).toBe(201);

    const editA = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: edit the sleep duration
    (editA.nodes[1] as any).meta = { duration: { hours: 24 } };
    const editB = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: edit the sleep duration
    (editB.nodes[1] as any).meta = { duration: { hours: 48 } };

    // Both calls read version 1 before either transaction begins; the
    // blueprint-keyed advisory lock then serializes the two writes, and the
    // loser's `version = 1` predicate matches zero rows once the winner bumped
    // to 2 — a structured `version_conflict` instead of a silent lost update.
    const results = await Promise.all([
      updateBlueprint({ container, id, patch: { graph: editA } }),
      updateBlueprint({ container, id, patch: { graph: editB } }),
    ]);

    const winners = results.filter((r) => r.ok);
    const conflicts = results.filter(
      (r) => !r.ok && r.code === "version_conflict",
    );
    expect(winners).toHaveLength(1);
    expect(conflicts).toHaveLength(1);

    // Version bumped exactly once — no double bump under the race.
    const detail = await (
      await app.request(`/v1/admin/blueprints/${id}`, { headers: AUTH_HEADER })
    ).json();
    expect(detail.blueprint.version).toBe(2);
  });
});

describe("GET /v1/admin/blueprints/:id/graph", () => {
  it("401s without auth and 404s for an unknown blueprint", async () => {
    expect(
      (await app.request(`/v1/admin/blueprints/${RUN}-none/graph`)).status,
    ).toBe(401);
    expect(
      (
        await app.request("/v1/admin/blueprints/nonexistent/graph", {
          headers: AUTH_HEADER,
        })
      ).status,
    ).toBe(404);
  });

  it("returns the graph + per-node metrics in the code-journey route's shape", async () => {
    const id = `${RUN}-graph`;
    expect((await createBlueprint(id)).status).toBe(201);

    // One live enrollment parked at the sleep node — a blueprint run is a
    // normal journey_states row with journeyId = the blueprint id.
    await db.insert(journeyStates).values({
      userId: STATE_USER,
      userEmail: `${STATE_USER}@example.com`,
      journeyId: id,
      currentNodeId: "sleep-3d",
      status: "waiting",
    });

    const res = await app.request(`/v1/admin/blueprints/${id}/graph`, {
      headers: AUTH_HEADER,
    });
    expect(res.status).toBe(200);
    const body = await res.json();

    // Graph is served verbatim.
    expect(body.graph.journeyId).toBe(id);
    expect(body.graph.nodes).toHaveLength(5);
    expect(body.graph.edges).toHaveLength(5);

    // Metrics: every node id has a zero-defaulted entry; the parked state
    // shows up as live on its node and in the enrolled total.
    for (const node of body.graph.nodes) {
      const metric = body.metrics.nodes[node.id];
      expect(metric).toBeDefined();
      expect(typeof metric.live).toBe("number");
      expect(typeof metric.failed).toBe("number");
    }
    expect(body.metrics.nodes["sleep-3d"].live).toBe(1);
    expect(body.metrics.enrolled).toBe(1);
    expect(body.metrics.terminals).toEqual({
      completed: 0,
      failed: 0,
      exited: 0,
    });

    // Send nodes carry the literal template key for the Studio preview.
    expect(body.metrics.nodes["send-nudge"].templateKey).toBe("welcome");

    // Shape parity with the code-journey graph route — the SAME flow-view
    // component must render either response without modification.
    const codeRes = await app.request("/v1/admin/journeys/feedback-nps/graph", {
      headers: AUTH_HEADER,
    });
    expect(codeRes.status).toBe(200);
    const codeBody = await codeRes.json();
    expect(Object.keys(body).sort()).toEqual(Object.keys(codeBody).sort());
    expect(Object.keys(body.metrics).sort()).toEqual(
      Object.keys(codeBody.metrics).sort(),
    );
    expect(Object.keys(body.metrics.terminals).sort()).toEqual(
      Object.keys(codeBody.metrics.terminals).sort(),
    );
    const sampleCodeMetric = Object.values(codeBody.metrics.nodes)[0] as Record<
      string,
      unknown
    >;
    const sampleBpMetric = body.metrics.nodes.start as Record<string, unknown>;
    for (const key of ["live", "failed"]) {
      expect(key in sampleCodeMetric).toBe(true);
      expect(key in sampleBpMetric).toBe(true);
    }
  });
});
