import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // The published package ships raw src/ (exports/files never include dist),
  // so declaration output is dead weight — same engine-type-graph OOM class
  // as plugin-discord.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ["@hogsend/core", "@hogsend/engine"],
});
