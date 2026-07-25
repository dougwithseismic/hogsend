import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  // `@hogsend/core` and `@hogsend/sms` ship raw `.ts`, so they MUST be inlined:
  // this dist bundle is loaded by Node from inside node_modules (see the
  // package.json note), where an external `import ... from "@hogsend/sms"`
  // would resolve to raw source and die with
  // ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING — the exact failure this bundle
  // exists to prevent. `@hogsend/sms` was previously external for that reason.
  //
  // Inlining `SmsSendError` is safe: the ONLY `instanceof` check against it
  // (src/send.ts) lives inside this package and compares against errors this
  // package itself constructed, so the duplicated class identity never spans a
  // module boundary. The engine never does an `instanceof` on it.
  //
  // `twilio` is real CommonJS on npm and stays external.
  noExternal: ["@hogsend/core", "@hogsend/sms"],
  // Types still come from raw `src/` (package.json `types` + the `types`
  // export condition), so declaration output remains dead weight — and the DTS
  // worker type-checks the whole engine graph, growing slower (and OOM-prone)
  // as the engine grows.
  dts: false,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: ["twilio"],
});
