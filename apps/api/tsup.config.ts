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
    "@hogsend/attribution",
    "@hogsend/core",
    "@hogsend/db",
    "@hogsend/email",
    "@hogsend/engine",
    // `@hogsend/mcp` ships its library surface as raw `src/*.ts` (like the other
    // `@hogsend/*` packages), so it MUST be bundled — Node can't resolve its
    // `.js`-suffixed relative imports against `.ts` sources at runtime. Its own
    // npm deps (`@hono/mcp`, `@modelcontextprotocol/sdk`) stay external and are
    // declared as direct deps below so they resolve from node_modules (#263).
    "@hogsend/mcp",
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
