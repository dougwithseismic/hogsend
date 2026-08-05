import { defineConfig } from "tsup";

export default defineConfig({
  // Only the stdio bin is built to dist/ — the library surface is consumed as
  // raw `src/*.ts` (like @hogsend/engine / @hogsend/core), so no `index.ts`
  // entry here.
  entry: ["src/bin.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: true,
  // Bundle the workspace packages so the published bin tarball doesn't depend
  // on un-published `@hogsend/*` source (mirrors packages/cli's rationale).
  //
  //  - `@hogsend/engine`: the only import is the zero-import, env-free
  //    authoring-guide leaf, so no other workspace package is reachable.
  //  - `@hogsend/cli`: the `cloud_*` tools use its `/cloud` surface (PRD 18).
  //    It is a DEV dependency and bundled here on purpose — declaring it as a
  //    runtime dep would put @hogsend/engine and @hogsend/db into the install
  //    graph of `npx @hogsend/mcp`, which is exactly the weight this bin
  //    exists to avoid. The `/cloud` barrel is engine-free by contract, so
  //    what lands in the bundle is the cloud client, the tarball packer and
  //    the credentials writer, and nothing else.
  //
  // npm deps (the MCP SDK, zod) stay external — resolved at runtime.
  noExternal: ["@hogsend/engine", "@hogsend/cli"],
});
