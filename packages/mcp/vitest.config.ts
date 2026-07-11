import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // `@hogsend/engine` ships raw `.ts`. We only import its env-FREE
    // authoring-guide leaf module (no barrel, no `env.ts`), so no server env
    // needs injecting. Inlining lets Vite resolve the subpath to its `.ts`
    // source instead of leaving it to Node's resolver.
    server: {
      deps: {
        inline: [/@hogsend\/engine/],
      },
    },
  },
});
