import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createAdminClient } from "./client.js";
import type { McpConfig } from "./config.js";
import { createHogsendMcpServer } from "./server.js";

/**
 * Run the MCP server over stdio. CRITICAL: stdout carries ONLY protocol
 * frames — all human output goes to stderr, or Claude's client hangs on a
 * corrupted stream.
 */
export async function runStdio(config: McpConfig): Promise<void> {
  const client = createAdminClient({
    baseUrl: config.baseUrl,
    adminKey: config.adminKey,
    userAgent: "hogsend-mcp/0.40.0",
  });
  const server = createHogsendMcpServer({ client, mode: config.mode });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `hogsend-mcp connected (instance: ${config.baseUrl}, mode: ${config.mode})\n`,
  );
}
