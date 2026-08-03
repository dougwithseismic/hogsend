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
  },
});
