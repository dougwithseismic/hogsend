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
    "@hogsend/plugin-twilio",
    "@hogsend/sms",
  ],
  // discord.js + twilio are real runtime deps resolved from node_modules —
  // pulled via dynamic import (twilio through the engine's guarded preset), so
  // they must NOT be bundled (they stay external like other npm deps).
  external: ["discord.js", "twilio"],
});
