import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // The @hogsend packages ship raw `.ts` and use `.js`-extension relative
  // imports, so they MUST be bundled (inlined) — Node's resolver cannot run
  // them as-is. Their external npm deps (hono, drizzle-orm, resend, ...) stay
  // external and resolve from node_modules at runtime. `@hogsend/engine` is
  // included so `node dist/index.js` runs without the engine's raw `.ts` ever
  // reaching Node's resolver.
  noExternal: [
    "@hogsend/core",
    "@hogsend/db",
    "@hogsend/email",
    "@hogsend/engine",
    "@hogsend/plugin-posthog",
    "@hogsend/plugin-resend",
  ],
});
