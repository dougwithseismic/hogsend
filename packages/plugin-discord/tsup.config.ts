import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/gateway/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // discord.js is the ONLY thing touching the socket; keep it out of the
  // engine-facing bundle so the API process never loads a WebSocket client.
  external: ["discord.js", "@hogsend/core", "@hogsend/engine"],
});
