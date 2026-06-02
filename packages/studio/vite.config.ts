import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The Studio is mounted under /studio by the engine (createApp routes seam),
// so all assets must be served from that base path. When served standalone
// via the `hogsend studio` CLI it is also rooted at /studio.
export default defineConfig({
  base: "/studio/",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
