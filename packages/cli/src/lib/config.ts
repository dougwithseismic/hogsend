import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

/** Resolved target for the admin HTTP client. */
export interface ResolvedConfig {
  /** Base URL of the target instance, no trailing slash. */
  baseUrl: string;
  /** Admin bearer token, if resolvable. `doctor`/health works without it. */
  adminKey: string | undefined;
}

/** Global flags parsed off the front of any command's argv. */
export interface GlobalFlags {
  url?: string;
  adminKey?: string;
  json: boolean;
  help: boolean;
  /** The remaining args after global flags are stripped. */
  rest: string[];
}

const DEFAULT_BASE_URL = "http://localhost:3002";

/**
 * Parse the global flags that every command honours (`--url`, `--admin-key`,
 * `--json`, `-h`/`--help`) off an argv slice, returning the parsed values plus
 * the leftover `rest` (positionals + unknown flags) for the command to handle.
 *
 * `strict: false` so command-specific flags (e.g. `--enabled`, `--limit`) pass
 * through untouched in `rest` rather than throwing here.
 */
export function parseGlobalFlags(argv: string[]): GlobalFlags {
  const { values, tokens } = parseArgs({
    args: argv,
    allowPositionals: true,
    strict: false,
    tokens: true,
    options: {
      url: { type: "string" },
      "admin-key": { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });

  // Rebuild `rest` from the token stream, dropping only the global flags we
  // own (and their values). Everything else — positionals and unknown option
  // tokens — is preserved verbatim for the command's own parser.
  const owned = new Set(["url", "admin-key", "json", "help", "h"]);
  const rest: string[] = [];
  for (const token of tokens) {
    if (token.kind === "positional") {
      rest.push(token.value);
    } else if (token.kind === "option") {
      if (owned.has(token.name)) continue;
      rest.push(token.rawName);
      if (token.value !== undefined && !token.inlineValue) {
        rest.push(token.value);
      } else if (token.inlineValue && token.value !== undefined) {
        // already captured in rawName? no — rebuild as --name=value
        rest[rest.length - 1] = `${token.rawName}=${token.value}`;
      }
    }
  }

  return {
    url: typeof values.url === "string" ? values.url : undefined,
    adminKey:
      typeof values["admin-key"] === "string" ? values["admin-key"] : undefined,
    json: values.json === true,
    help: values.help === true,
    rest,
  };
}

/**
 * Manually parse a `.env` file into a flat record. No dotenv dependency: a
 * small, forgiving parser (KEY=VALUE per line, `#` comments, optional quotes,
 * `export ` prefix tolerated). Never throws — a missing/unreadable file yields
 * an empty record so config resolution stays robust in any cwd.
 */
export function loadDotEnv(
  cwd: string = process.cwd(),
): Record<string, string> {
  const out: Record<string, string> = {};
  const file = join(cwd, ".env");
  if (!existsSync(file)) return out;
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return out;
  }
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ")
      ? line.slice("export ".length)
      : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (key === "") continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/**
 * Resolve the target config with precedence flags > process.env > .env, falling
 * back to the local-dev default base URL.
 *
 *   baseUrl: --url > HOGSEND_API_URL (env) > HOGSEND_API_URL (.env) > localhost:3002
 *   adminKey: --admin-key > HOGSEND_ADMIN_KEY|ADMIN_API_KEY (env) > (.env equiv)
 */
export function resolveConfig(
  flags: GlobalFlags,
  cwd: string = process.cwd(),
): ResolvedConfig {
  const dotenv = loadDotEnv(cwd);

  const baseUrlRaw =
    flags.url ??
    process.env.HOGSEND_API_URL ??
    dotenv.HOGSEND_API_URL ??
    DEFAULT_BASE_URL;

  const adminKey =
    flags.adminKey ??
    process.env.HOGSEND_ADMIN_KEY ??
    process.env.ADMIN_API_KEY ??
    dotenv.HOGSEND_ADMIN_KEY ??
    dotenv.ADMIN_API_KEY;

  return {
    baseUrl: baseUrlRaw.replace(/\/+$/, ""),
    adminKey: adminKey && adminKey.length > 0 ? adminKey : undefined,
  };
}
