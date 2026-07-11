/**
 * `createHogsendMcpServer` — assembles the MCP server: the three tools
 * (`manage_blueprint`, `hogsend_report`, `send_test_email`), the
 * `hogsend://blueprint-authoring-guide` resource, and the
 * `find_and_fix_bottleneck` prompt. Every tool talks to the injected
 * {@link AdminClient}, so the SAME server assembles identically over the stdio
 * bin's real-fetch client and Phase 3's in-process `app.request()` client.
 *
 * Uses the MCP SDK v1.x registration API (`registerTool(name, { description,
 * inputSchema }, cb)` where `inputSchema` is a Zod raw shape;
 * `registerResource`, `registerPrompt`).
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AdminClient } from "./lib/admin-client.js";
import { findAndFixPrompt } from "./prompts/find-and-fix.js";
import { authoringGuideResource } from "./resources/authoring-guide.js";
import { createManageBlueprintTool } from "./tools/manage-blueprint.js";
import { createReportTool } from "./tools/report.js";
import { createSendTestEmailTool } from "./tools/send-test-email.js";

const SERVER_NAME = "hogsend-mcp";
// Read the version from package.json (no hand-maintained literal to drift). A
// runtime require — not a static JSON import — so `tsc` (rootDir: src) never
// tries to pull package.json into the program. Mirrors packages/cli/src/bin.ts.
const SERVER_VERSION = (
  createRequire(import.meta.url)("../package.json") as { version: string }
).version;

export interface CreateHogsendMcpServerOptions {
  client: AdminClient;
}

/** Serialize a tool's discriminated `ok` result into a text content block. */
function toContent(result: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
}

/** Build a fresh `McpServer` with all tools/resource/prompt registered. */
export function createHogsendMcpServer(
  opts: CreateHogsendMcpServerOptions,
): McpServer {
  const { client } = opts;
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  // Registered inline (not via a generic helper) so the SDK infers each tool's
  // concrete raw-shape from the factory's return type. Handlers take `unknown`
  // and never throw for expected failures, so the SDK arg typing is unused.
  const manageBlueprint = createManageBlueprintTool(client);
  server.registerTool(
    manageBlueprint.name,
    {
      description: manageBlueprint.description,
      inputSchema: manageBlueprint.inputSchema,
    },
    async (args): Promise<CallToolResult> =>
      toContent(await manageBlueprint.handler(args)),
  );

  const report = createReportTool(client);
  server.registerTool(
    report.name,
    { description: report.description, inputSchema: report.inputSchema },
    async (args): Promise<CallToolResult> =>
      toContent(await report.handler(args)),
  );

  const sendTestEmail = createSendTestEmailTool(client);
  server.registerTool(
    sendTestEmail.name,
    {
      description: sendTestEmail.description,
      inputSchema: sendTestEmail.inputSchema,
    },
    async (args): Promise<CallToolResult> =>
      toContent(await sendTestEmail.handler(args)),
  );

  server.registerResource(
    authoringGuideResource.name,
    authoringGuideResource.uri,
    {
      title: authoringGuideResource.title,
      description: authoringGuideResource.description,
      mimeType: authoringGuideResource.mimeType,
    },
    async (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: authoringGuideResource.mimeType,
          text: authoringGuideResource.text,
        },
      ],
    }),
  );

  server.registerPrompt(
    findAndFixPrompt.name,
    {
      title: findAndFixPrompt.title,
      description: findAndFixPrompt.description,
    },
    () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: findAndFixPrompt.message },
        },
      ],
    }),
  );

  return server;
}
