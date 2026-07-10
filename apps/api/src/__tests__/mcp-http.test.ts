/**
 * P2 — remote MCP over Streamable HTTP mounted on the engine at /mcp.
 * Full-stack: real Hono app served on an ephemeral port, the official SDK
 * client over StreamableHTTPClientTransport with bearer header auth (exactly
 * how a claude.ai custom connector reaches it).
 */
import type { HogsendClient } from "@hogsend/engine";
import { afterAll, describe, expect, it, vi } from "vitest";

process.env.DATABASE_URL =
  "postgresql://growthhog:growthhog@localhost:5434/growthhog";
// Opt-in BEFORE createApp (registerMcpRoute reads it at mount time).
process.env.MCP_HTTP_ENABLED = "true";

const { serve } = await import("@hono/node-server");
const { createApp, createHogsendClient } = await import("@hogsend/engine");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import(
  "@modelcontextprotocol/sdk/client/streamableHttp.js"
);
const { journeys } = await import("../journeys/index.js");
const { templates } = await import("../emails/index.js");
const { lists } = await import("../lists/index.js");

const mockHatchet = {
  durableTask: vi.fn(() => ({ run: vi.fn(), runNoWait: vi.fn() })),
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

// Ephemeral port; server closed in afterAll.
const server = serve({ fetch: app.fetch, port: 0 });
const port = (server.address() as { port: number }).port;
const url = new URL(`http://127.0.0.1:${port}/mcp`);

afterAll(() => {
  server.close();
  delete process.env.MCP_HTTP_ENABLED;
});

function connect(headers: Record<string, string>) {
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: { headers },
  });
  const client = new Client({ name: "http-test", version: "0.0.0" });
  return { client, transport };
}

describe("remote MCP over /mcp (streamable HTTP)", () => {
  it("rejects an unauthenticated initialize", async () => {
    const { client, transport } = connect({});
    await expect(client.connect(transport)).rejects.toThrow(
      /401|Unauthorized/i,
    );
  });

  it("initializes with bearer auth, lists tools, and round-trips a real read", async () => {
    const { client, transport } = connect({
      authorization: `Bearer ${process.env.ADMIN_API_KEY}`,
    });
    await client.connect(transport);

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "hogsend_report",
      "manage_journey",
      "send_test_email",
    ]);

    // A real tools/call: catalog goes in-process through /v1/admin with the
    // caller's own bearer (rate-limit + audit run on every effect).
    const result = await client.callTool({
      name: "hogsend_report",
      arguments: { scope: "catalog" },
    });
    const text = (result.content as Array<{ text: string }>)[0]?.text ?? "";
    expect(text).toContain("Journeys (");
    expect(text).toContain("Email templates (");

    await client.close();
  });
});
