#!/usr/bin/env node
import { parseFlags, resolveConfig } from "./config.js";
import { runStdio } from "./stdio.js";

try {
  const config = resolveConfig(parseFlags(process.argv.slice(2)));
  await runStdio(config);
} catch (err) {
  process.stderr.write(
    `hogsend-mcp: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
}
