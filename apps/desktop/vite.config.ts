import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The desktop shell is a self-contained SPA loaded by the Tauri webview from
// `frontendDist` (../dist) in production and from the dev server in `tauri dev`.
// A fixed port keeps `tauri.conf.json`'s `devUrl` in sync; 5174 avoids clashing
// with `@hogsend/studio` (5173).
const DEV_PORT = 5174;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  // Tauri serves the bundle from a custom protocol root, so assets must be
  // referenced relatively rather than from "/".
  base: "./",
  clearScreen: false,
  server: {
    port: DEV_PORT,
    strictPort: true,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    target: "safari15",
  },
});
