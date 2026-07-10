import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AdminClient } from "./client.js";
import type { McpMode } from "./config.js";
import { SPEC_REFERENCE } from "./lib/spec-reference.js";
import { registerTools } from "./registry.js";
import { allTools } from "./tools/index.js";

const VERSION = "0.40.0";

const SPEC_REFERENCE_URI = "hogsend://journey-spec-reference";

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

  // The JourneySpec authoring guide as an on-demand resource — keeps the
  // manage_journey description small (tool definitions cost context on every
  // conversation; resources load only when the model reaches for them).
  server.registerResource(
    "journey-spec-reference",
    SPEC_REFERENCE_URI,
    {
      title: "JourneySpec authoring reference",
      description:
        "How to write the JSON journey spec accepted by manage_journey create/update: envelope, step vocabulary, branch conditions, validation rules, and a worked example.",
      mimeType: "text/markdown",
    },
    async () => ({
      contents: [
        {
          uri: SPEC_REFERENCE_URI,
          mimeType: "text/markdown",
          text: SPEC_REFERENCE,
        },
      ],
    }),
  );

  // Canned orchestration of the headline demo.
  server.registerPrompt(
    "find_and_fix_bottleneck",
    {
      title: "Find and fix the worst marketing bottleneck",
      description:
        "Runs the health report, explains the worst finding, and (with the user's approval at each step) drafts a journey to fix it.",
    },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              "Audit my marketing with hogsend_report (scope health) and walk me through the findings in plain English, worst first.",
              "Then propose a fix for the worst one. If the fix is a new journey: read hogsend://journey-spec-reference and the template catalog, draft the spec, create it (it will be disabled), and show me the walkthrough.",
              "Do NOT enable anything until I explicitly say so.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  return server;
}
