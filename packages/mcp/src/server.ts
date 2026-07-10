import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./client.js";
import type { McpMode } from "./config.js";
import { registerTools } from "./registry.js";
import { allTools } from "./tools/index.js";

const VERSION = "0.40.0";

/**
 * Build a Hogsend MCP server bound to one AdminClient. Transport-agnostic —
 * the stdio entry and the engine-mounted HTTP route both call this; only where
 * the client points differs.
 */
export function createHogsendMcpServer(opts: {
  client: AdminClient;
  mode: McpMode;
}): McpServer {
  const server = new McpServer({
    name: "hogsend",
    version: VERSION,
  });
  registerTools(server, opts.client, { mode: opts.mode, tools: allTools });
  return server;
}
