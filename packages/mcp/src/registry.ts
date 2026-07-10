import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ZodRawShape } from "zod";
import type { AdminClient } from "./client.js";
import type { McpMode } from "./config.js";

/**
 * One Hogsend MCP tool. The registry is deliberately tiny — 3 tools total
 * (report / manage / test-email), following the evidence that a small
 * outcome-oriented surface beats an API mirror (Block's Linear server landed on
 * 2 after starting at 30+).
 */
export interface ToolDef {
  name: string;
  title: string;
  description: string;
  /** "read" registers in both modes; "write" only when mode === "write". */
  tier: "read" | "write";
  inputSchema: ZodRawShape;
  handler: (
    args: Record<string, unknown>,
    client: AdminClient,
  ) => Promise<CallToolResult>;
}

/** Uniform error → CallToolResult so the model gets an actionable message. */
export function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Uniform success: compact text for the model + full structured payload. */
export function toolResult(
  text: string,
  structured?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [{ type: "text", text }],
    ...(structured ? { structuredContent: structured } : {}),
  };
}

/**
 * Register the toolset onto an `McpServer`, bound to ONE AdminClient. Both
 * transports (stdio, engine-mounted HTTP) call this — the transport only
 * decides where the client points. `mode: "read"` registers only read tools
 * (they don't exist for the client — no 403 noise, no context cost).
 */
export function registerTools(
  server: McpServer,
  client: AdminClient,
  opts: { mode: McpMode; tools: ToolDef[] },
): void {
  for (const tool of opts.tools) {
    if (tool.tier === "write" && opts.mode !== "write") continue;
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: { readOnlyHint: tool.tier === "read" },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        try {
          return await tool.handler(args ?? {}, client);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return toolError(`${tool.name} failed: ${message}`);
        }
      },
    );
  }
}
