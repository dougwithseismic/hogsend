import { defineConfig } from "tsup";

// Three builds:
//  - the client overlay must keep its "use client" boundary;
//  - the server handler is plain Node (esm+cjs), NO "use client";
//  - the config wrapper (`./next`) is ESM-ONLY: it uses `import.meta.url` to
//    locate the loader, which has no valid CJS form — and a Next config that
//    imports an ESM package is itself ESM, so a CJS variant would never be used.
// The raw `loader/stamp-loader.cjs` is shipped as-is (package.json "files") and
// deliberately not built — Turbopack loads it directly as a CommonJS loader.
const nodeOut = ({ format }: { format: string }) => ({
  js: format === "cjs" ? ".cjs" : ".js",
});

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm", "cjs"],
    target: "es2022",
    platform: "browser",
    outDir: "dist",
    dts: true,
    clean: true,
    sourcemap: true,
    external: ["react", "react-dom", "react/jsx-runtime"],
    banner: { js: '"use client";' },
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
    outExtension: nodeOut,
  },
  {
    entry: { server: "src/server.ts" },
    format: ["esm", "cjs"],
    target: "node22",
    platform: "node",
    outDir: "dist",
    dts: true,
    clean: false,
    sourcemap: true,
    outExtension: nodeOut,
  },
  {
    entry: { next: "src/next.ts" },
    format: ["esm"],
    target: "node22",
    platform: "node",
    outDir: "dist",
    dts: true,
    clean: false,
    sourcemap: true,
  },
]);
