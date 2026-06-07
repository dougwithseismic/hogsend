import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  target: "node22",
  outDir: "dist",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // @hogsend/email is a TYPE-ONLY optional peer — it is never imported at
  // runtime, only referenced in `import type`. Keep it external so it is never
  // bundled and an un-augmented consumer (no @hogsend/email installed) still
  // works.
  external: ["@hogsend/email"],
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
