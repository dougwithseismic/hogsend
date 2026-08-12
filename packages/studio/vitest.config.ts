import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone vitest config, deliberately NOT merged with vite.config.ts: the
// app config pulls in the React + Tailwind plugins and a /studio/ base path,
// none of which the node-environment unit tests need. Components under test
// render via react-dom/server (static markup), so no DOM environment either.
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
