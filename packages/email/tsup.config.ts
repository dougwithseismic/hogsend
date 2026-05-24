import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node22",
  outDir: "dist",
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react-email",
    "resend",
    "svix",
    "@hogsend/db",
    "drizzle-orm",
  ],
});
