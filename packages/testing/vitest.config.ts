import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    server: {
      deps: {
        inline: [/@hogsend\/(core|email|engine|sms|testing)/],
      },
    },
  },
});
