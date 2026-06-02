#!/usr/bin/env node
// bundle-studio.mjs — copy the built Studio SPA into the CLI package so it ships
// in the published tarball (package.json files[] includes "studio").
//
// Runs as the CLI's `prebuild`. The `hogsend studio` command serves this bundled
// dist. Best-effort: if the studio hasn't been built, we warn and continue so the
// CLI can still build standalone (the command falls back to the monorepo dist or
// errors with a clear "build it first" message at runtime).
import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, "..");
const studioDist = resolve(cliRoot, "../studio/dist");
const dest = join(cliRoot, "studio");

if (!existsSync(join(studioDist, "index.html"))) {
  console.warn(
    "[bundle-studio] no built Studio at packages/studio/dist — skipping " +
      "(run `pnpm --filter @hogsend/studio build` first to bundle it).",
  );
  process.exit(0);
}

rmSync(dest, { recursive: true, force: true });
cpSync(studioDist, dest, { recursive: true });
console.log(`[bundle-studio] copied Studio dist -> ${dest}`);
