import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // `@hogsend/core` ships raw `.ts`, so it MUST be inlined: this dist bundle is
  // loaded by Node from inside node_modules (see the package.json note), where
  // an external `import ... from "@hogsend/core"` would resolve to raw source
  // and die with ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — the exact
  // failure this bundle exists to prevent. Real npm deps stay external.
  noExternal: ["@hogsend/core"],
  // Types still come from raw `src/` (package.json `types` + the `types`
  // export condition), so declaration output remains dead weight — and the DTS
  // worker type-checks the whole engine graph, growing slower (and OOM-prone)
  // as the engine grows.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ["zod"],
});
