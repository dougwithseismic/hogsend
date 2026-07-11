import { defineConfig } from "tsup";

export default defineConfig({
  // Only the stdio bin is built to dist/ — the library surface is consumed as
  // raw `src/*.ts` (like @hogsend/engine / @hogsend/core), so no `index.ts`
  // entry here.
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle @hogsend/engine so the published bin tarball doesn't depend on
  // un-published `@hogsend/*` source (mirrors packages/cli's rationale). The
  // only engine import is the zero-import, env-free authoring-guide leaf, so no
  // other workspace package is reachable to bundle. npm deps (the MCP SDK, zod)
  // stay external — resolved from node_modules at runtime.
  noExternal: ["@hogsend/engine"],
});
