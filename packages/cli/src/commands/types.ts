import type { ResolvedConfig } from "../lib/config.js";
import type { AdminClient } from "../lib/http.js";
import type { Output } from "../lib/output.js";

/**
 * Per-invocation context handed to every command's `run()`. The router builds
 * this once (after parsing global flags + resolving config) and passes it in,
 * so command files never touch process.argv directly, never resolve config,
 * and never construct an HTTP client themselves.
 */
export interface CommandContext {
  /**
   * The args AFTER the command token. e.g. for `hogsend journeys list --json`
   * the router strips `journeys` and the global `--json`, leaving `["list"]`.
   * Subcommand dispatch (list/get/...) is the command's own responsibility.
   */
  argv: string[];
  /** Base URL + admin key, already resolved via flags > env > .env. */
  cfg: ResolvedConfig;
  /** Pre-built admin HTTP client, bound to `cfg`. */
  http: AdminClient;
  /** Output sink — human (TTY clack) vs json, already mode-selected. */
  out: Output;
  /** True when the global `--json` flag was passed. Mirrors `out.isJson`. */
  json: boolean;
}

/**
 * The descriptor every command file implements. The router matches `name`
 * against the leading argv token and dispatches to `run()`.
 */
export interface Command {
  /** Command token, e.g. "journeys", "eject". */
  name: string;
  /** One-line help shown in the root command list. */
  summary: string;
  /** Multiline usage block shown on `hogsend <name> --help`. */
  usage: string;
  /** Execute the command. Throw to fail (router renders + exits 1). */
  run(ctx: CommandContext): Promise<void>;
}
