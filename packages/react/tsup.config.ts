import { defineConfig } from "tsup";

// BUILD SPIKE (per plan §1/§10): no in-repo package builds React via tsup
// (Studio uses Vite). Validate after build that:
//   (i)   `banner` injects `"use client";` at the top of each JS output,
//   (ii)  `loader:{".css":"copy"}` emits `dist/styles.css`,
//   (iii) the `./styles.css` export + `sideEffects` resolve in a consumer.
// If it doesn't emit cleanly, fall back to a Vite-lib build for this package.
export default defineConfig({
  // Keyed entries → flat, predictable output names. Granular component
  // subpaths (`./feed`, `./popover`, `./bell`) let consumers `React.lazy` the
  // heavier feed surfaces without the whole barrel (plan §6/§7 budget). The "."
  // barrel still re-exports everything (v1 contract preserved).
  entry: {
    index: "src/index.ts",
    feed: "src/components/feed/notification-feed.tsx",
    popover: "src/components/popover/feed-popover.tsx",
    bell: "src/components/bell/notification-bell.tsx",
    banner: "src/components/banner/banner.tsx",
    toast: "src/components/toast/toast-container.tsx",
    "styles/styles": "src/styles/styles.css",
  },
  format: ["esm", "cjs"],
  // Browser target, NOT "node22".
  target: "es2022",
  outDir: "dist",
  dts: true,
  clean: true,
  splitting: true,
  sourcemap: true,
  // React is a peer — never bundle it.
  external: ["react", "react-dom", "react/jsx-runtime"],
  // Preserve the RSC "use client" boundary on every output.
  banner: { js: '"use client";' },
  // Emit the stylesheet to dist/styles.css instead of inlining.
  loader: { ".css": "copy" },
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
