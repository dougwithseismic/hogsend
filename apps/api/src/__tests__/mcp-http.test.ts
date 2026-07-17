/**
 * @hogsend/mcp hosted transport (Phase 3) — end-to-end over the REAL MCP SDK
 * client. Boots the dogfood app (with `mcpRoutes()` mounted) on an ephemeral
 * port via `@hono/node-server`, then drives it with
 * `@modelcontextprotocol/sdk`'s `Client` over `StreamableHTTPClientTransport` —
 * the exact wire a claude.ai connector uses.
 *
 * Proves: the endpoint is admin-gated (an unauthenticated client can't connect),
 * an authenticated initialize surfaces the 3 tools + the resource + the prompt,
 * the full authoring loop (create → validate → enable → report → disable) works
 * through the in-process AdminClient (which re-issues each admin call back
 * through the same app with the caller's bearer key), `send_test_email` returns
 * a structured result, and a duplicate-create surfaces the 409 `conflict` code
 * end-to-end.
 *
 * Real Postgres + the container/mockHatchet setup mirror `admin-blueprints.test`.
 * The email provider is a network-free fake (id "resend" overrides the env
 * preset) so `send_test_email` never reaches a real inbox.
 */
import type { HogsendClient } from "@hogsend/engine";
import { serve } from "@hono/node-server";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";

const { createApp, createHogsendClient, defineEmailProvider } = await import(
  "@hogsend/engine"
);
const { mcpRoutes } = await import("@hogsend/mcp");
const { contacts, emailSends, journeyBlueprints, journeyStates } = await import(
  "@hogsend/db"
);
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
  task: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
  events: { push: vi.fn() },
  runs: { cancel: vi.fn(), get: vi.fn() },
  worker: vi.fn(),
} as unknown as HogsendClient["hatchet"];

// A network-free email provider (id "resend" ⇒ overrides the env preset) so
// `send_test_email` resolves deterministically without reaching a real inbox.
const fakeEmailProvider = defineEmailProvider({
  meta: { id: "resend", name: "Test Fake Provider" },
  capabilities: { nativeTracking: false },
  send: async () => ({ id: "test-message-id" }),
  sendBatch: async (items) => ({
    results: items.map(() => ({ id: "test-message-id" })),
  }),
  verifyWebhook: async () => {
    throw new Error("verifyWebhook not implemented in mcp-http test");
  },
  parseWebhook: () => {
    throw new Error("parseWebhook not implemented in mcp-http test");
  },
});

const container = createHogsendClient({
  journeys,
  conversions,
  lists,
  email: { templates, provider: fakeEmailProvider },
  overrides: { hatchet: mockHatchet },
});
const app = createApp(container, { routes: [mcpRoutes()] });
const { db } = container;

const ADMIN_KEY = process.env.ADMIN_API_KEY;
const AUTH = { Authorization: `Bearer ${ADMIN_KEY}` };

// Run-scoped id prefix so parallel test files against the shared docker DB never
// collide; everything created here is swept in afterAll.
const RUN = `mcphttp-${Date.now()}`;
// The send_test_email recipient — writes an email_sends row (and may upsert a
// contact); both are swept in afterAll.
const SEND_TEST_TO = `${RUN}@mcp-http-test.example`;

let server: ReturnType<typeof serve>;
let mcpUrl: URL;

beforeAll(async () => {
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
  });
  mcpUrl = new URL(`http://localhost:${port}/v1/mcp`);
});

afterAll(async () => {
  await db.delete(journeyStates).where(like(journeyStates.userId, `${RUN}%`));
  await db
    .delete(journeyBlueprints)
    .where(like(journeyBlueprints.id, `${RUN}%`));
  // send_test_email side effects: the email_sends row + any upserted contact.
  await db.delete(emailSends).where(eq(emailSends.toEmail, SEND_TEST_TO));
  await db.delete(contacts).where(eq(contacts.email, SEND_TEST_TO));
  await new Promise<void>((resolve) => {
    if (!server) return resolve();
    server.close(() => resolve());
  });
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

/** Connect a fresh SDK client, optionally with credential headers. */
async function connect(headers?: Record<string, string>): Promise<Client> {
  const client = new Client({ name: "mcp-http-test", version: "0.0.0" });
  const transport = new StreamableHTTPClientTransport(mcpUrl, {
    requestInit: headers ? { headers } : undefined,
  });
  await client.connect(transport);
  return client;
}

/** Parse a tool result's JSON text-content block into its structured object. */
// biome-ignore lint/suspicious/noExplicitAny: open discriminated union asserted per-test.
function parseToolResult(result: unknown): any {
  const content =
    (result as { content?: Array<{ type: string; text?: string }> }).content ??
    [];
  const block = content.find(
    (c) => c.type === "text" && typeof c.text === "string",
  );
  if (!block?.text) {
    throw new Error("tool result had no text content block");
  }
  return JSON.parse(block.text);
}

describe("hosted MCP transport (POST /v1/mcp)", () => {
  it("rejects an unauthenticated client (requireAdmin ⇒ 401)", async () => {
    const client = new Client({ name: "unauth", version: "0.0.0" });
    const transport = new StreamableHTTPClientTransport(mcpUrl);
    await expect(client.connect(transport)).rejects.toThrow();
    await client.close().catch(() => {});
  });

  it("lists the three tools after an authenticated initialize", async () => {
    const client = await connect(AUTH);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hogsend_report",
      "manage_blueprint",
      "send_test_email",
    ]);
    await client.close();
  });

  it("serves the authoring-guide resource", async () => {
    const client = await connect(AUTH);
    const { resources } = await client.listResources();
    expect(resources.map((r) => r.uri)).toContain(
      "hogsend://blueprint-authoring-guide",
    );
    const read = await client.readResource({
      uri: "hogsend://blueprint-authoring-guide",
    });
    const text = (read.contents[0] as { text?: string }).text ?? "";
    expect(text.length).toBeGreaterThan(100);
    await client.close();
  });

  it("serves the find_and_fix_bottleneck prompt", async () => {
    const client = await connect(AUTH);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name)).toContain("find_and_fix_bottleneck");
    const prompt = await client.getPrompt({ name: "find_and_fix_bottleneck" });
    expect(prompt.messages.length).toBeGreaterThan(0);
    await client.close();
  });

  it("runs the full authoring loop and reflects it in hogsend_report", async () => {
    const client = await connect(AUTH);
    const id = `${RUN}-roundtrip`;

    const create = parseToolResult(
      await client.callTool({
        name: "manage_blueprint",
        arguments: {
          action: "create",
          name: "MCP HTTP roundtrip",
          triggerEvent: `${RUN}.enroll`,
          entryLimit: "once",
          suppress: {},
          graph: nudgeGraph(id),
        },
      }),
    );
    expect(create.ok).toBe(true);
    expect(create.blueprint.id).toBe(id);
    // Provenance is stamped by the tool, never taken from input.
    expect(create.blueprint.source).toBe("mcp");

    const validate = parseToolResult(
      await client.callTool({
        name: "manage_blueprint",
        arguments: { action: "validate", id },
      }),
    );
    expect(validate.ok).toBe(true);
    expect(validate.valid).toBe(true);
    expect(validate.issues).toEqual([]);

    const enable = parseToolResult(
      await client.callTool({
        name: "manage_blueprint",
        arguments: { action: "enable", id },
      }),
    );
    expect(enable.ok).toBe(true);
    expect(enable.blueprint.status).toBe("enabled");

    // Backdate `updatedAt` past the dead-trigger age gate so the heuristic fires
    // — proving the report reads the just-enabled blueprint through the full
    // HTTP path (report only lists blueprints; a freshly enabled one is "new").
    await db
      .update(journeyBlueprints)
      .set({ updatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
      .where(eq(journeyBlueprints.id, id));

    const report = parseToolResult(
      await client.callTool({
        name: "hogsend_report",
        arguments: { scope: "blueprints" },
      }),
    );
    expect(report.ok).toBe(true);
    expect(report.scope).toBe("blueprints");
    // The report envelope is self-describing about the calling credential.
    expect(report.generatedFor.actor).toBe("api-key");
    const finding = report.findings.find(
      (f: { id: string }) => f.id === `dead-blueprint:${id}`,
    );
    expect(finding).toBeDefined();
    expect(finding.evidence).toContain(id);

    const disable = parseToolResult(
      await client.callTool({
        name: "manage_blueprint",
        arguments: { action: "disable", id },
      }),
    );
    expect(disable.ok).toBe(true);
    expect(disable.blueprint.status).toBe("disabled");

    await client.close();
  });

  it("send_test_email returns a structured result against the template registry", async () => {
    const client = await connect(AUTH);
    const templateKey = Object.keys(templates)[0];
    const res = parseToolResult(
      await client.callTool({
        name: "send_test_email",
        arguments: {
          templateKey,
          to: SEND_TEST_TO,
        },
      }),
    );
    // Assert the discriminated shape (not a specific outcome): the send path
    // depends on test-mode/provider state, but the tool must always return a
    // well-formed `ok` result — never a throw.
    expect(typeof res.ok).toBe("boolean");
    if (res.ok) {
      expect(typeof res.status).toBe("string");
    } else {
      expect(typeof res.code).toBe("string");
    }
    await client.close();
  });

  it("surfaces a 409 conflict code end-to-end (duplicate create)", async () => {
    const client = await connect(AUTH);
    const id = `${RUN}-dup`;
    const args = {
      action: "create",
      name: "Duplicate id",
      triggerEvent: `${RUN}.enroll`,
      entryLimit: "once",
      suppress: {},
      graph: nudgeGraph(id),
    };

    const first = parseToolResult(
      await client.callTool({ name: "manage_blueprint", arguments: args }),
    );
    expect(first.ok).toBe(true);

    const second = parseToolResult(
      await client.callTool({ name: "manage_blueprint", arguments: args }),
    );
    expect(second.ok).toBe(false);
    expect(second.code).toBe("conflict");
    expect(second.status).toBe(409);

    await client.close();
  });
});
