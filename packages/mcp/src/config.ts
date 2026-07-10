/**
 * Config resolution for the stdio entry: flags > env. No .env file loading here
 * — MCP client configs (Claude Desktop/Code JSON) pass env explicitly, and the
 * `hogsend mcp` CLI command layers its own .env resolution before calling in.
 */

export type McpMode = "read" | "write";

export interface McpConfig {
  baseUrl: string;
  adminKey: string;
  /** Which toolset registers: "read" = report only; "write" = everything. */
  mode: McpMode;
}

export interface ResolveOverrides {
  baseUrl?: string;
  adminKey?: string;
  mode?: string;
}

/** Resolve config from overrides (CLI flags / caller) falling back to env. */
export function resolveConfig(overrides: ResolveOverrides = {}): McpConfig {
  const baseUrl =
    overrides.baseUrl ??
    process.env.HOGSEND_API_URL ??
    process.env.API_PUBLIC_URL ??
    "http://localhost:3002";

  const adminKey =
    overrides.adminKey ??
    process.env.HOGSEND_ADMIN_KEY ??
    process.env.ADMIN_API_KEY;
  if (!adminKey) {
    throw new Error(
      "no admin key configured — set HOGSEND_ADMIN_KEY (or ADMIN_API_KEY) in the MCP server env",
    );
  }

  const rawMode = overrides.mode ?? process.env.HOGSEND_MCP_MODE ?? "write";
  const mode: McpMode = rawMode === "read" ? "read" : "write";

  return { baseUrl: baseUrl.replace(/\/+$/, ""), adminKey, mode };
}

/** Parse `--flag value` / `--flag=value` pairs from argv (bin entry). */
export function parseFlags(argv: string[]): ResolveOverrides {
  const out: ResolveOverrides = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg?.startsWith("--")) continue;
    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? argv[++i] : arg.slice(eq + 1);
    if (value === undefined) continue;
    if (name === "url" || name === "base-url") out.baseUrl = value;
    if (name === "admin-key") out.adminKey = value;
    if (name === "mode") out.mode = value;
  }
  return out;
}
