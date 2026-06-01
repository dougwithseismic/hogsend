import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  clean: true,
  splitting: false,
  // The CLI runs as plain JS via `pnpm dlx create-hogsend`, so it MUST build to
  // `dist` (unlike the other @hogsend packages, which ship raw `.ts`). The
  // shebang makes the emitted bin directly executable.
  banner: { js: "#!/usr/bin/env node" },
});
