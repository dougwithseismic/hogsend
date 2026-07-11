import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/gateway/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // The published package ships raw src/ (exports/files never include dist),
  // so declaration output is dead weight — and the DTS worker type-checks the
  // whole engine graph, OOMing at Node's default heap as the engine grows.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  // discord.js is the ONLY thing touching the socket; keep it out of the
  // engine-facing bundle so the API process never loads a WebSocket client.
  external: ["discord.js", "@hogsend/core", "@hogsend/engine"],
});
