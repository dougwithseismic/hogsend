import { defineConfig } from "tsup";

// Two config blocks: only the React entry gets the RSC "use client" banner —
// the core/adapter entries must stay importable from server code.
export default defineConfig([
  {
    entry: {
      index: "src/index.ts",
      youtube: "src/providers/youtube.ts",
      vimeo: "src/providers/vimeo.ts",
      html5: "src/providers/html5.ts",
      hogsend: "src/hogsend.ts",
    },
    format: ["esm", "cjs"],
    // Browser target, NOT "node22".
    target: "es2022",
    outDir: "dist",
    // clean happens in the build script — the two config blocks build
    // concurrently and an in-config clean deletes the other block's output.
    dts: true,
    clean: false,
    splitting: true,
    sourcemap: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  {
    entry: { react: "src/react/index.tsx" },
    format: ["esm", "cjs"],
    target: "es2022",
    outDir: "dist",
    dts: true,
    clean: false,
    sourcemap: true,
    external: ["react", "react/jsx-runtime"],
    banner: { js: '"use client";' },
    esbuildOptions(options) {
      options.jsx = "automatic";
    },
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
]);
