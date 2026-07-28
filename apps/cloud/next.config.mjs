import { fileURLToPath } from "node:url";

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Standalone emits a self-contained server.js so the deploy runtime needs no
  // pnpm workspace install. outputFileTracingRoot points at the monorepo root
  // so Next traces workspace deps correctly.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // DEV ONLY (Next ignores this in a build): without it, a dev server reached
  // over the loopback IP or a LAN address serves HTML but blocks every
  // `/_next` resource, so the page arrives unhydrated and every form falls
  // back to a native GET — which posts the password into the URL bar.
  allowedDevOrigins: ["127.0.0.1"],
};

export default config;
