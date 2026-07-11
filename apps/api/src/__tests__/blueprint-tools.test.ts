/**
 * Journey Blueprints phase 4 — the agent-facing tool set
 * (`createJourneyBlueprintTools`, spec §9): a transport-agnostic
 * `{ name, description, inputSchema, handler }` wrapper over the SAME
 * service layer the admin routes use. Handlers are called directly
 * (in-process — exactly how an MCP server or the AI SDK would call them),
 * against real Postgres, Hatchet mocked via the container override seam.
 *
 * Proves: every expected failure is a structured result (`ok: false` +
 * `code` + issues), never a thrown exception — input-parse failures
 * (`invalid_input`), graph failures (`invalid_graph`, with the same
 * `BlueprintValidationIssue[]` the routes return), id collisions
 * (`conflict`), missing rows (`not_found`), promoted blueprints
 * (`promoted`). Provenance is stamped by the surface (`source: "mcp"`,
 * `createdBy` from the mount), the version-bump rule matches PATCH, enable
 * re-validates the STORED graph against CURRENT registries, and the
 * template/event vocabulary tools expose real registries (templates) or an
 * honestly-labeled open vocabulary (events).
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createHogsendClient, createJourneyBlueprintTools } = await import(
  "@hogsend/engine"
);
const { journeyBlueprints, journeyStates, userEvents } = await import(
  "@hogsend/db"
);
const { eq, like } = await import("drizzle-orm");
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
  runs: {
    cancel: vi.fn(),
    get: vi.fn(),
  },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

const container = createHogsendClient({
  journeys,
  lists,
  email: { templates },
  overrides: { hatchet: mockHatchet },
});
const { db } = container;

const tools = createJourneyBlueprintTools({
  container,
  createdBy: "vitest-mcp",
});

// Run-scoped id prefix so parallel test files against the shared docker DB
// never collide; everything it created is swept in afterAll.
const RUN = `bpt-${Date.now()}`;
const EVENTS_USER = `${RUN}-user`;

afterAll(async () => {
  await db.delete(userEvents).where(eq(userEvents.userId, EVENTS_USER));
  await db.delete(journeyStates).where(eq(journeyStates.userId, EVENTS_USER));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}%`));
});

/** Valid execution-tier graph: enroll → sleep → decision → send → end. */
function nudgeGraph(blueprintId: string, template = "welcome") {
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
        meta: { template },
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

function createInput(blueprintId: string, overrides: object = {}) {
  return {
    name: "Activation nudge",
    description: "Nudge users who did not activate",
    triggerEvent: `${RUN}.enroll`,
    entryLimit: "once",
    suppress: {},
    graph: nudgeGraph(blueprintId),
    ...overrides,
  };
}

describe("create_journey_blueprint", () => {
  it("creates a draft blueprint, stamping source=mcp and the mount's createdBy", async () => {
    const id = `${RUN}-create`;
    const result = await tools.create_journey_blueprint.handler(
      createInput(id),
    );

    expect(result).toMatchObject({ ok: true });
    if (!("blueprint" in result)) throw new Error("expected write success");
    expect(result.blueprint.id).toBe(id); // id IS graph.journeyId
    expect(result.blueprint.status).toBe("draft");
    expect(result.blueprint.version).toBe(1);
    expect(result.blueprint.source).toBe("mcp");
    expect(result.blueprint.createdBy).toBe("vitest-mcp");
    expect(result.blueprint.graph.nodes).toHaveLength(5);
    expect(result.blueprint.createdAt).toBeTruthy();
  });

  it("may create directly enabled, and a per-call createdBy wins over the mount default", async () => {
    const result = await tools.create_journey_blueprint.handler(
      createInput(`${RUN}-live`, {
        status: "enabled",
        createdBy: "session-42",
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      blueprint: { status: "enabled", createdBy: "session-42" },
    });
  });

  it("returns structured invalid_graph issues (never throws) and writes nothing", async () => {
    const id = `${RUN}-invalid`;
    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[1] as any).meta = {}; // strip the sleep's required duration

    const result = await tools.create_journey_blueprint.handler(
      createInput(id, { graph }),
    );

    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues.length).toBeGreaterThan(0);
    const sleepIssue = result.issues.find((i) => i.nodeId === "sleep-3d");
    expect(sleepIssue).toBeDefined();

    const row = await db
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, id));
    expect(row).toHaveLength(0);
  });

  it("rejects an unregistered template key at save time (registry half of the sandbox)", async () => {
    const id = `${RUN}-unknown-template`;
    const result = await tools.create_journey_blueprint.handler(
      createInput(id, { graph: nudgeGraph(id, "not-a-registered-template") }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues.some((i) => i.code === "unknown_template")).toBe(true);
  });

  it("rejects a reserved-namespace triggerEvent with structured issues and writes nothing", async () => {
    const id = `${RUN}-reserved-trigger`;
    const result = await tools.create_journey_blueprint.handler(
      createInput(id, { triggerEvent: "email.opened" }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues[0]).toMatchObject({
      code: "reserved_event",
      path: ["triggerEvent"],
    });

    const row = await db
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, id));
    expect(row).toHaveLength(0);
  });

  it("rejects a trigger NODE that forges a reserved-namespace event", async () => {
    const id = `${RUN}-reserved-node`;
    const result = await tools.create_journey_blueprint.handler(
      createInput(id, { graph: triggerGraph(id, "bucket.entered") }),
    );
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(
      result.issues.some(
        (i) => i.code === "reserved_event" && i.nodeId === "fire-event",
      ),
    ).toBe(true);
  });

  it("rejects a duplicate blueprint id with conflict", async () => {
    const id = `${RUN}-dupe`;
    const first = await tools.create_journey_blueprint.handler(createInput(id));
    expect(first).toMatchObject({ ok: true });

    const second = await tools.create_journey_blueprint.handler(
      createInput(id),
    );
    expect(second).toMatchObject({ ok: false, code: "conflict" });
  });

  it("rejects an id colliding with a registered code journey", async () => {
    const result = await tools.create_journey_blueprint.handler(
      createInput("activation-welcome", {
        graph: nudgeGraph("activation-welcome"),
      }),
    );
    expect(result).toMatchObject({ ok: false, code: "conflict" });
    if (result.ok) throw new Error("expected failure");
    expect(result.error).toContain("code journey");
  });

  it("returns invalid_input (not a throw) when the arguments don't parse", async () => {
    const result = await tools.create_journey_blueprint.handler({
      // name + entryLimit + suppress + triggerEvent all missing
      graph: nudgeGraph(`${RUN}-bad-input`),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues.some((i) => i.path.join(".") === "name")).toBe(true);
  });
});

describe("update_journey_blueprint", () => {
  it("re-validates a graph change and bumps version; metadata-only edits don't bump", async () => {
    const id = `${RUN}-update`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const renamed = await tools.update_journey_blueprint.handler({
      id,
      name: "Renamed",
    });
    expect(renamed).toMatchObject({
      ok: true,
      blueprint: { name: "Renamed", version: 1 },
    });

    const graphChanged = await tools.update_journey_blueprint.handler({
      id,
      graph: nudgeGraph(id),
    });
    expect(graphChanged).toMatchObject({
      ok: true,
      blueprint: { version: 2 },
    });
  });

  it("rejects an invalid replacement graph with structured issues", async () => {
    const id = `${RUN}-update-invalid`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const graph = nudgeGraph(id);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[3] as any).meta = {}; // strip the send's required template

    const result = await tools.update_journey_blueprint.handler({ id, graph });
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues.some((i) => i.nodeId === "send-nudge")).toBe(true);
  });

  it("rejects a graph whose journeyId doesn't match the (immutable) blueprint id", async () => {
    const id = `${RUN}-update-mismatch`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const result = await tools.update_journey_blueprint.handler({
      id,
      graph: nudgeGraph(`${RUN}-other-id`),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues[0]?.code).toBe("journey_id_mismatch");
  });

  it("returns not_found for a missing blueprint", async () => {
    const result = await tools.update_journey_blueprint.handler({
      id: `${RUN}-ghost`,
      name: "Nope",
    });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("rejects patching triggerEvent into a reserved namespace", async () => {
    const id = `${RUN}-update-reserved`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const result = await tools.update_journey_blueprint.handler({
      id,
      triggerEvent: "contact.updated",
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues[0]?.code).toBe("reserved_event");

    const [row] = await db
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, id));
    expect(row?.triggerEvent).toBe(`${RUN}.enroll`);
  });

  it("rejects a replacement graph carrying a reserved trigger node", async () => {
    const id = `${RUN}-update-reserved-node`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const result = await tools.update_journey_blueprint.handler({
      id,
      graph: triggerGraph(id, "journey:failed"),
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(
      result.issues.some(
        (i) => i.code === "reserved_event" && i.nodeId === "fire-event",
      ),
    ).toBe(true);
  });

  it("rejects a graph change with in_flight while an enrollment is active or waiting", async () => {
    const id = `${RUN}-update-inflight`;
    await tools.create_journey_blueprint.handler(createInput(id));

    await db.insert(journeyStates).values({
      userId: EVENTS_USER,
      userEmail: `${EVENTS_USER}@example.com`,
      journeyId: id,
      currentNodeId: "sleep-3d",
      status: "waiting",
    });

    const graphResult = await tools.update_journey_blueprint.handler({
      id,
      graph: nudgeGraph(id),
    });
    expect(graphResult).toMatchObject({ ok: false, code: "in_flight" });

    // Metadata-only edits are unaffected by the same in-flight state.
    const metaResult = await tools.update_journey_blueprint.handler({
      id,
      name: "Still fine",
    });
    expect(metaResult).toMatchObject({ ok: true, blueprint: { version: 1 } });
  });

  it("returns invalid_input when only `id` is provided", async () => {
    const result = await tools.update_journey_blueprint.handler({
      id: `${RUN}-update`,
    });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("validate_journey_blueprint", () => {
  it("reports valid for a good unsaved graph (dry-run, no write)", async () => {
    const id = `${RUN}-never-saved`;
    const result = await tools.validate_journey_blueprint.handler({
      graph: nudgeGraph(id),
    });
    expect(result).toEqual({ ok: true, valid: true, issues: [] });

    const row = await db
      .select()
      .from(journeyBlueprints)
      .where(eq(journeyBlueprints.id, id));
    expect(row).toHaveLength(0);
  });

  it("reports valid:false with node-addressed issues — a failed validation is a successful call", async () => {
    const graph = nudgeGraph(`${RUN}-iterating`);
    // biome-ignore lint/suspicious/noExplicitAny: deliberately malformed fixture
    (graph.nodes[1] as any).meta = {};

    const result = await tools.validate_journey_blueprint.handler({ graph });
    expect(result).toMatchObject({ ok: true, valid: false });
    if (!("valid" in result)) throw new Error("expected report");
    expect(result.issues.some((i) => i.nodeId === "sleep-3d")).toBe(true);
  });

  it("re-validates a STORED graph by id", async () => {
    const id = `${RUN}-validate-stored`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const result = await tools.validate_journey_blueprint.handler({ id });
    expect(result).toEqual({ ok: true, valid: true, issues: [] });
  });

  it("returns not_found for an unknown id", async () => {
    const result = await tools.validate_journey_blueprint.handler({
      id: `${RUN}-ghost`,
    });
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  it("requires exactly one of graph or id", async () => {
    const both = await tools.validate_journey_blueprint.handler({
      id: `${RUN}-x`,
      graph: nudgeGraph(`${RUN}-x`),
    });
    expect(both).toMatchObject({ ok: false, code: "invalid_input" });

    const neither = await tools.validate_journey_blueprint.handler({});
    expect(neither).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("list_email_templates", () => {
  it("exposes the registered template keys with subject + category", async () => {
    const result = await tools.list_email_templates.handler(undefined);
    if (!("templates" in result)) throw new Error("expected templates");

    const welcome = result.templates.find((t) => t.key === "welcome");
    expect(welcome).toBeDefined();
    expect(typeof welcome?.defaultSubject).toBe("string");

    // Sorted, and exactly the registry's keys — the send-node vocabulary.
    const keys = result.templates.map((t) => t.key);
    expect(keys).toEqual([...keys].sort());
    expect(keys).toContain("activation-nudge");
  });
});

describe("list_events", () => {
  it("merges observed events with journey/blueprint trigger declarations, honestly labeled", async () => {
    await db.insert(userEvents).values({
      userId: EVENTS_USER,
      event: `${RUN}.observed`,
      source: "test",
    });
    await tools.create_journey_blueprint.handler(
      createInput(`${RUN}-events-bp`),
    );

    const result = await tools.list_events.handler({ search: RUN });
    if (!("events" in result)) throw new Error("expected events");
    expect(result.note).toContain("open vocabulary");

    const observed = result.events.find((e) => e.name === `${RUN}.observed`);
    expect(observed).toMatchObject({ occurrences: 1 });
    expect(observed?.lastSeenAt).toBeTruthy();

    // Declared-but-never-fired blueprint trigger still shows up.
    const trigger = result.events.find((e) => e.name === `${RUN}.enroll`);
    expect(trigger).toBeDefined();
    expect(
      trigger?.usedBy.some((u) => u.startsWith(`blueprint:${RUN}-events-bp`)),
    ).toBe(true);
  });

  it("labels code-journey triggers", async () => {
    const result = await tools.list_events.handler({
      search: "user.created",
    });
    if (!("events" in result)) throw new Error("expected events");
    const entry = result.events.find((e) => e.name === "user.created");
    expect(entry?.usedBy).toContain("journey:activation-welcome");
  });

  it("rejects an out-of-range limit as invalid_input", async () => {
    const result = await tools.list_events.handler({ limit: 0 });
    expect(result).toMatchObject({ ok: false, code: "invalid_input" });
  });
});

describe("enable_journey_blueprint / disable_journey_blueprint", () => {
  it("enables a draft and disables it again", async () => {
    const id = `${RUN}-lifecycle`;
    await tools.create_journey_blueprint.handler(createInput(id));

    const enabled = await tools.enable_journey_blueprint.handler({ id });
    expect(enabled).toMatchObject({
      ok: true,
      blueprint: { status: "enabled" },
    });

    const disabled = await tools.disable_journey_blueprint.handler({ id });
    expect(disabled).toMatchObject({
      ok: true,
      blueprint: { status: "disabled" },
    });
  });

  it("refuses to enable when the STORED graph no longer passes the current registries", async () => {
    // Seed directly (bypassing save-time validation) to simulate registry
    // drift: the graph references a template that is not registered.
    const id = `${RUN}-drifted`;
    await db.insert(journeyBlueprints).values({
      id,
      name: "Drifted",
      status: "draft",
      triggerEvent: `${RUN}.enroll`,
      entryLimit: "once",
      suppress: {},
      graph: nudgeGraph(id, "template-deleted-since-save"),
      source: "api",
    });

    const result = await tools.enable_journey_blueprint.handler({ id });
    expect(result).toMatchObject({ ok: false, code: "invalid_graph" });
    if (!("issues" in result)) throw new Error("expected issues");
    expect(result.issues.some((i) => i.code === "unknown_template")).toBe(true);
  });

  it("refuses to re-enable a promoted blueprint — the code journey is the source of truth", async () => {
    const id = `${RUN}-promoted`;
    await db.insert(journeyBlueprints).values({
      id,
      name: "Promoted",
      status: "disabled",
      triggerEvent: `${RUN}.enroll`,
      entryLimit: "once",
      suppress: {},
      graph: nudgeGraph(id),
      source: "api",
      promotedAt: new Date(),
      promotedToJourneyId: id,
    });

    const result = await tools.enable_journey_blueprint.handler({ id });
    expect(result).toMatchObject({ ok: false, code: "promoted" });
  });

  it("returns not_found for both lifecycle tools on a missing id", async () => {
    const enable = await tools.enable_journey_blueprint.handler({
      id: `${RUN}-ghost`,
    });
    expect(enable).toMatchObject({ ok: false, code: "not_found" });

    const disable = await tools.disable_journey_blueprint.handler({
      id: `${RUN}-ghost`,
    });
    expect(disable).toMatchObject({ ok: false, code: "not_found" });
  });
});

describe("tool shape (mounting contract)", () => {
  it("every tool carries name/description/inputSchema/handler, keyed by its own name", async () => {
    for (const [key, tool] of Object.entries(tools)) {
      expect(tool.name).toBe(key);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(typeof tool.handler).toBe("function");
      // safeParse-able zod schema — what an MCP/AI-SDK mount needs.
      expect(typeof tool.inputSchema.safeParse).toBe("function");
    }
  });
});
