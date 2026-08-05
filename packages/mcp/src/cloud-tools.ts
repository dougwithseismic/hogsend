import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toContent } from "./lib/tool.js";
import {
  createCloudBuildStatusTool,
  createCloudPublishTool,
  createCloudSignupTool,
  createCloudVerifyTool,
  createCloudWhoamiTool,
} from "./tools/cloud.js";

/**
 * `registerCloudTools` — the STDIO-ONLY half of this server.
 *
 * Why this is a separate function rather than a flag on
 * `createHogsendMcpServer`: the hosted `/v1/mcp` variant must not carry these,
 * and "must not" deserves better than a boolean somebody could pass wrongly.
 * The stdio bin calls this; `routes.ts` does not import it. Absence on the
 * hosted server is therefore a property of the import graph — the strongest
 * form available here — and `server.test.ts` asserts it from the outside.
 *
 * WHY THEY MAY NOT BE HOSTED, stated once so nobody adds them later:
 * every `cloud_*` tool acts on the machine it RUNS on. It reads and writes
 * `~/.hogsend/credentials.json`, packs a directory from the local filesystem,
 * and signs in as whoever is at that terminal. On a tenant's hosted instance
 * that machine is a shared server: the credentials file would be the
 * operator's, the filesystem would be the platform's, and a tool that published
 * "the scaffold at cwd" would be publishing something no caller chose. There is
 * no version of these tools that is safe there, which is why the answer is
 * absence rather than a permission check.
 *
 * The tools take no client argument, unlike the admin tools: their "client" is
 * the operator's own credentials file and the cloud URL from the environment —
 * the same funnel the `hogsend` CLI uses, so the two are interchangeable.
 */

/** The names registered here, for tests and for the hosted-absence assertion. */
export const CLOUD_TOOL_NAMES = [
  "cloud_signup",
  "cloud_verify",
  "cloud_whoami",
  "cloud_publish",
  "cloud_build_status",
] as const;

export function registerCloudTools(server: McpServer): McpServer {
  // Registered inline (not through a loop) for the same reason `server.ts`
  // does it: the SDK infers each tool's concrete raw shape from the factory's
  // return type, and a loop over a heterogeneous array erases that.
  const signup = createCloudSignupTool();
  server.registerTool(
    signup.name,
    { description: signup.description, inputSchema: signup.inputSchema },
    async (args): Promise<CallToolResult> =>
      toContent(await signup.handler(args)),
  );

  const verify = createCloudVerifyTool();
  server.registerTool(
    verify.name,
    { description: verify.description, inputSchema: verify.inputSchema },
    async (args): Promise<CallToolResult> =>
      toContent(await verify.handler(args)),
  );

  const whoami = createCloudWhoamiTool();
  server.registerTool(
    whoami.name,
    { description: whoami.description, inputSchema: whoami.inputSchema },
    async (args): Promise<CallToolResult> =>
      toContent(await whoami.handler(args)),
  );

  const publish = createCloudPublishTool();
  server.registerTool(
    publish.name,
    { description: publish.description, inputSchema: publish.inputSchema },
    async (args): Promise<CallToolResult> =>
      toContent(await publish.handler(args)),
  );

  const buildStatus = createCloudBuildStatusTool();
  server.registerTool(
    buildStatus.name,
    {
      description: buildStatus.description,
      inputSchema: buildStatus.inputSchema,
    },
    async (args): Promise<CallToolResult> =>
      toContent(await buildStatus.handler(args)),
  );

  return server;
}
