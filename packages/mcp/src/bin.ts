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
import { registerCloudTools } from "./cloud-tools.js";
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

  // NO ADMIN KEY IS NOT FATAL ANY MORE (PRD 18). The `cloud_*` tools sign this
  // machine in and publish a scaffold, and at that point in the journey there
  // is no instance to hold an admin key for — refusing to start would make the
  // server useless for exactly the flow it was extended to serve. What happens
  // instead: the instance tools are not registered, the cloud tools are, and
  // stderr says so.
  const client = adminKey
    ? createFetchAdminClient({ baseUrl, adminKey })
    : undefined;
  const server = createHogsendMcpServer(client ? { client } : {});

  // STDIO ONLY. These act on this machine's credentials file and filesystem,
  // which is coherent here and is not on a shared hosted instance — see
  // `cloud-tools.ts`. The hosted transport (`routes.ts`) never imports it.
  registerCloudTools(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  log(
    client
      ? `connected (stdio) → ${baseUrl}`
      : "connected (stdio), cloud tools only — set HOGSEND_ADMIN_KEY (or --admin-key) to also manage an instance.",
  );
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
