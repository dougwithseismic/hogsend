import { runStdio } from "@hogsend/mcp";
import type { Command } from "./types.js";

/**
 * `hogsend mcp` — run the Hogsend MCP server over stdio, for Claude Code /
 * Claude Desktop / Cursor `.mcp.json` configs:
 *
 *   { "mcpServers": { "hogsend": { "command": "hogsend", "args": ["mcp"] } } }
 *
 * Auth reuses the CLI's resolution (flags > env > .env): the admin key comes
 * from `--admin-key` / HOGSEND_ADMIN_KEY / ADMIN_API_KEY, the instance from
 * `--url` / HOGSEND_API_URL. `--mode read` registers only the read tool.
 *
 * IMPORTANT: stdout is the MCP protocol channel — nothing human is printed
 * there (the MCP package logs to stderr only).
 */
export const mcpCommand: Command = {
  name: "mcp",
  summary: "Run the MCP server (stdio) so Claude can talk to this instance",
  usage: [
    "hogsend mcp [--mode read|write]",
    "",
    "Connect from Claude Code:",
    "  claude mcp add hogsend -- hogsend mcp",
    "",
    "Flags:",
    "  --mode read|write   Toolset to expose (default write; read = report only)",
  ].join("\n"),
  async run(ctx) {
    const modeFlag = ctx.argv.indexOf("--mode");
    const mode =
      modeFlag !== -1 && ctx.argv[modeFlag + 1] === "read" ? "read" : "write";
    if (!ctx.cfg.adminKey) {
      throw new Error(
        "no admin key configured — pass --admin-key, or set HOGSEND_ADMIN_KEY / ADMIN_API_KEY",
      );
    }
    await runStdio({
      baseUrl: ctx.cfg.baseUrl,
      adminKey: ctx.cfg.adminKey,
      mode,
    });
    // runStdio resolves once connected; keep the process alive for the client.
    await new Promise(() => {});
  },
};
