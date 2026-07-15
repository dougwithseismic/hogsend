import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // The published package ships raw src/ (exports/files never include dist),
  // so declaration output is dead weight — and the DTS worker type-checks the
  // whole engine graph, growing slower (and OOM-prone) as the engine grows.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ["react", "react-dom", "react-email"],
});
