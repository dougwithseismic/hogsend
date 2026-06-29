import { fileURLToPath } from "node:url";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Standalone output is fumadocs' recommended self-host/Docker target: it emits
  // a self-contained server.js bundling its own minimal node_modules, so the
  // runtime needs no pnpm workspace or install. outputFileTracingRoot points at
  // the monorepo root so Next traces workspace deps correctly.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
};

export default withMDX(config);
