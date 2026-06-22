import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/worker.ts", "src/discord-worker.ts"],
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
    "@hogsend/engine",
    "@hogsend/plugin-discord",
    "@hogsend/plugin-posthog",
    "@hogsend/plugin-resend",
    "@hogsend/plugin-telegram",
  ],
  // discord.js is a real runtime dep resolved from node_modules — the gateway
  // worker pulls it via a dynamic `import("discord.js")`, so it must NOT be
  // bundled (it's large, native-ish, and stays external like other npm deps).
  external: ["discord.js"],
});
