#!/usr/bin/env node
import { createRequire } from "node:module";
import { commands } from "./commands/index.js";
import type { Command } from "./commands/types.js";
import { parseGlobalFlags, resolveConfig } from "./lib/config.js";
import { createAdminClient, createDataPlaneClient } from "./lib/http.js";
import { color, createOutput } from "./lib/output.js";

function version(): string {
  try {
    const require = createRequire(import.meta.url);
    const pkg = require("../package.json") as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function rootUsage(): string {
  const longest = commands.reduce((n, c) => Math.max(n, c.name.length), 0);
  const list = commands
    .map((c) => `  ${color.cyan(c.name.padEnd(longest))}  ${c.summary}`)
    .join("\n");
  return `${color.bold("hogsend")} — the agent-native Hogsend CLI

${color.dim("Usage:")} hogsend <command> [options]

${color.dim("Commands:")}
${list}

${color.dim("Global options:")}
  --url <baseUrl>     Target instance (default HOGSEND_API_URL or http://localhost:3002)
  --admin-key <key>   Admin bearer token (default HOGSEND_ADMIN_KEY / ADMIN_API_KEY)
  --data-key <key>    Ingest bearer token for writes (default HOGSEND_DATA_KEY / HOGSEND_API_KEY)
  --json              Emit machine-readable JSON only (for agents)
  -h, --help          Show help (use after a command for command help)
  -v, --version       Show version

Run ${color.cyan("hogsend <command> --help")} for command-specific options.`;
}

function findCommand(name: string): Command | undefined {
  return commands.find((c) => c.name === name);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [token, ...afterToken] = argv;

  // Version is a top-level concern (before flag parsing).
  if (token === "-v" || token === "--version") {
    process.stdout.write(`${version()}\n`);
    return;
  }

  // No command, or a root-level help request.
  if (!token || token === "-h" || token === "--help") {
    process.stdout.write(`${rootUsage()}\n`);
    return;
  }

  const command = findCommand(token);
  if (!command) {
    // Unknown command: report on stderr and show usage. Not json-gated since
    // there's no resolved Output yet.
    process.stderr.write(
      `${color.red("error")} unknown command "${token}"\n\n${rootUsage()}\n`,
    );
    process.exit(1);
  }

  // Parse global flags off the post-token argv; the rest is the command's argv.
  const flags = parseGlobalFlags(afterToken);
  const out = createOutput({ json: flags.json });

  // `hogsend <cmd> --help` short-circuits to the command's usage block.
  if (flags.help) {
    out.log(command.usage);
    return;
  }

  const cfg = resolveConfig(flags);
  const http = createAdminClient(cfg);
  const dataHttp = createDataPlaneClient(cfg);

  await command.run({
    argv: flags.rest,
    cfg,
    http,
    dataHttp,
    out,
    json: flags.json,
  });
}

main().catch((error: unknown) => {
  const msg = error instanceof Error ? error.message : String(error);
  // Best-effort json detection for top-level failures (Output may not exist).
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ error: msg })}\n`);
  } else {
    process.stderr.write(`${color.red("error")} ${msg}\n`);
  }
  process.exit(1);
});
