import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [
    "@hogsend/core",
    "@hogsend/db",
    "@hogsend/email",
    "@hogsend/plugin-posthog",
    "@hogsend/plugin-resend",
  ],
});
