import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: [
      "src/index.ts",
      "src/preferences/index.ts",
      "src/feed/index.ts",
      "src/banner/index.ts",
      "src/toast/index.ts",
      "src/realtime/index.ts",
    ],
    format: ["esm", "cjs"],
    // NOTE: browser target, NOT "node22" — these SDKs run in the browser and
    // must not let tsup assume Node built-ins/globals. DOM libs come from
    // @repo/typescript-config/base.json.
    target: "es2022",
    outDir: "dist",
    dts: true,
    clean: true,
    // The ONE deviation from @hogsend/client's tsup: shared internals
    // (transport/store/errors) collapse into a single shared chunk for the
    // ESM/bundler path. (CJS still duplicates — acceptable, browsers use ESM.)
    splitting: true,
    sourcemap: true,
    outExtension({ format }) {
      return { js: format === "cjs" ? ".cjs" : ".js" };
    },
  },
  // Drop-in build: one minified IIFE the engine serves at `GET /hogsend.js`
  // for sites without a bundler. Self-boots from the script tag's `data-*`.
  {
    entry: { hogsend: "src/snippet.ts" },
    format: ["iife"],
    globalName: "__hogsendSnippet",
    platform: "browser",
    target: "es2020",
    outDir: "dist",
    minify: true,
    sourcemap: false,
    dts: false,
    clean: false,
    outExtension() {
      return { js: ".js" };
    },
  },
]);
