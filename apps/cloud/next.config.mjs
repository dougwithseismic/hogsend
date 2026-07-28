import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Standalone emits a self-contained server.js so the deploy runtime needs no
  // pnpm workspace install. outputFileTracingRoot points at the monorepo root
  // so Next traces workspace deps correctly.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default config;
