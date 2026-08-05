import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // ONLY this package's own source. `template/` carries the scaffolded app's
    // vitest suites, which import `@hogsend/*` from the app's node_modules —
    // they run inside a scaffolded app (and in `scripts/verify-scaffold.sh`),
    // never from here.
    include: ["src/**/*.test.ts"],
    // Each scaffold run spawns the built CLI and writes a real app to a temp
    // dir; the default 5s is tight for the first cold run.
    testTimeout: 60_000,
    // Every suite here builds `dist/` in its `beforeAll` (the CLI under test is
    // the BUILT one) and then spawns it. Run in parallel, two suites race tsup
    // into the same output directory and one of them reads a half-written
    // bundle — which surfaces as an unrelated-looking "tsup failed" or a
    // spawn error, intermittently. Serialising is the fix; the whole file set
    // runs in under a second either way.
    fileParallelism: false,
  },
});
