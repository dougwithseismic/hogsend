import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/bin.ts", "src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle the workspace packages so the published CLI tarball doesn't depend
  // on un-published `@hogsend/*` source. Tree-shaking keeps this to just the
  // auth + drizzle path used by `studio admin` (createAuth + createDatabase).
  // `better-auth` and other npm deps stay external (resolved from node_modules
  // at runtime).
  noExternal: [
    "@hogsend/engine",
    "@hogsend/db",
    "@hogsend/mcp",
    "@hogsend/core",
  ],
});
