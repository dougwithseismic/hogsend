/**
 * Full MCP protocol round-trip: SDK Client ↔ createHogsendMcpServer over the
 * in-memory transport pair. Guards tools/list shape, mode gating, and a real
 * tools/call — the safety net for SDK upgrades.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { AdminClient, Query } from "../client.js";
import { createHogsendMcpServer } from "../server.js";

function stubClient(routes: Record<string, unknown>): AdminClient {
  const lookup = (path: string): unknown => {
    const hit = Object.keys(routes).find((k) => path.startsWith(k));
    if (hit) return routes[hit];
    const err = new Error(`404: no stub for ${path}`) as Error & {
      status: number;
    };
    err.status = 404;
    throw err;
  };
  return {
    baseUrl: "http://test.local",
    get: async <T>(path: string, _q?: Query) => lookup(path) as T,
    post: async <T>(path: string) => lookup(path) as T,
    put: async <T>(path: string) => lookup(path) as T,
    patch: async <T>(path: string) => lookup(path) as T,
  };
}

async function connect(
  mode: "read" | "write",
  routes: Record<string, unknown>,
) {
  const server = createHogsendMcpServer({ client: stubClient(routes), mode });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
  return client;
}

describe("MCP protocol integration", () => {
  it("lists the toolset with schemas", async () => {
    const client = await connect("write", {});
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("hogsend_report");
    const report = tools.find((t) => t.name === "hogsend_report");
    expect(report?.description).toContain("health");
    expect(report?.inputSchema).toBeDefined();
    expect(report?.annotations?.readOnlyHint).toBe(true);
  });

  it("round-trips a tools/call", async () => {
    const client = await connect("write", {
      "/v1/admin/journeys": { journeys: [], total: 0 },
      "/v1/admin/templates": { templates: [{ key: "welcome" }] },
    });
    const result = await client.callTool({
      name: "hogsend_report",
      arguments: { scope: "catalog" },
    });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toContain("welcome");
  });

  it("read mode hides write tools entirely", async () => {
    const client = await connect("read", {});
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});
