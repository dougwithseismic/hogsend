import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle @hogsend/core so the published tarball doesn't depend on the
  // unpublished workspace source. The MCP SDK + zod stay external (resolved
  // from node_modules at runtime).
  noExternal: ["@hogsend/core"],
});
