#!/usr/bin/env node
/**
 * `hogsend-mcp` — the stdio entry point (`npx @hogsend/mcp`, for Claude
 * Desktop / Cursor / any local MCP client). Resolves the target instance and
 * admin key from env + argv, builds a real-fetch {@link AdminClient} and the
 * server, and connects a `StdioServerTransport`.
 *
 * CRITICAL: stdout is the JSON-RPC protocol channel — anything human-facing
 * MUST go to stderr, never stdout, or it corrupts the MCP stream.
 */
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFetchAdminClient } from "./lib/admin-client.js";
import { createHogsendMcpServer } from "./server.js";

const DEFAULT_API_URL = "http://localhost:3002";

function log(message: string): void {
  process.stderr.write(`hogsend-mcp: ${message}\n`);
}

/** Resolve baseUrl/adminKey with precedence: argv flags > env. */
function resolveConfig(): { baseUrl: string; adminKey: string | undefined } {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      url: { type: "string" },
      "admin-key": { type: "string" },
    },
  });

  const urlFlag = typeof values.url === "string" ? values.url : undefined;
  const keyFlag =
    typeof values["admin-key"] === "string" ? values["admin-key"] : undefined;

  const baseUrl = urlFlag ?? process.env.HOGSEND_API_URL ?? DEFAULT_API_URL;
  // Accept both the CLI's HOGSEND_ADMIN_KEY and the legacy ADMIN_API_KEY.
  const adminKey =
    keyFlag ?? process.env.HOGSEND_ADMIN_KEY ?? process.env.ADMIN_API_KEY;

  return {
    baseUrl,
    adminKey: adminKey && adminKey.length > 0 ? adminKey : undefined,
  };
}

async function main(): Promise<void> {
  const { baseUrl, adminKey } = resolveConfig();

  if (!adminKey) {
    log(
      "no admin key configured. Set HOGSEND_ADMIN_KEY (or ADMIN_API_KEY), or pass --admin-key <key>.",
    );
    process.exit(1);
  }

  const client = createFetchAdminClient({ baseUrl, adminKey });
  const server = createHogsendMcpServer({ client });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(`connected (stdio) → ${baseUrl}`);
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
