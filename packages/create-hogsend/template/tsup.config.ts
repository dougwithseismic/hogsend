import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Every `@hogsend/*` package ships raw `.ts` with `.js`-extension relative
  // imports, so any that reaches Node's resolver crashes at runtime with
  // ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING. Bundle them ALL via one regex so
  // adding a plugin later — `pnpm add @hogsend/plugin-discord`, `-telegram`,
  // `-postmark`, … — just works with no edit here (an explicit list silently
  // omits new plugins; it type-checks and builds, then only crashes at boot).
  // Their external npm deps (hono, drizzle-orm, resend, …) stay external and
  // resolve from node_modules at runtime. `@hogsend/studio` is never bundled:
  // it's a prebuilt static SPA the engine locates via `require.resolve`, not a
  // code import, so tsup leaves it in node_modules where the engine serves it.
  noExternal: [/^@hogsend\//],
});
