import { fileURLToPath } from "node:url";
import { withInspector } from "@hogsend/inspector/next";
import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  // Standalone output is fumadocs' recommended self-host/Docker target: it emits
  // a self-contained server.js bundling its own minimal node_modules, so the
  // runtime needs no pnpm workspace or install. Required here because railpack's
  // slim runtime image prunes the workspace node_modules. outputFileTracingRoot
  // points at the monorepo root so Next traces workspace deps correctly.
  output: "standalone",
  outputFileTracingRoot: fileURLToPath(new URL("../../", import.meta.url)),
  // PostHog ingests on `eu.i.posthog.com`, a host on every common ad-blocker
  // list (EasyPrivacy, uBlock defaults) — our developer audience blocks it at a
  // high rate, so client-side capture/identify silently never lands. The
  // `/relay/*` rewrites below proxy ingestion (and the static-assets host)
  // through our OWN first-party origin, so the requests look same-origin and
  // sail past blockers. posthog-boot.tsx points `api_host` at `/relay` to match.
  // skipTrailingSlashRedirect keeps PostHog's API paths (/relay/e/, /relay/flags)
  // from being 308-redirected by Next's trailing-slash handling mid-capture.
  skipTrailingSlashRedirect: true,
  async rewrites() {
    return [
      {
        source: "/relay/static/:path*",
        destination: "https://eu-assets.i.posthog.com/static/:path*",
      },
      // Remote SDK config (`/array/<token>/config.js`) is served from the
      // ASSETS host — it must proxy there too, or it falls through to the
      // catch-all (ingestion host) and loses the assets-host cache-control
      // headers, risking stale feature-flag / session-recording / survey config.
      // This is PostHog's documented three-rule proxy pattern (static, array, catch-all).
      {
        source: "/relay/array/:path*",
        destination: "https://eu-assets.i.posthog.com/array/:path*",
      },
      {
        source: "/relay/:path*",
        destination: "https://eu.i.posthog.com/:path*",
      },
    ];
  },
  async redirects() {
    return [
      // Host-based 301s: the site is served at hogsend.com (root). The old
      // docs.hogsend.com host and www both redirect path-preserving — docs
      // URLs live under /docs on every host, so no path rewriting is needed.
      {
        source: "/:path*",
        has: [{ type: "host", value: "docs.hogsend.com" }],
        destination: "https://hogsend.com/:path*",
        permanent: true,
      },
      {
        source: "/:path*",
        has: [{ type: "host", value: "www.hogsend.com" }],
        destination: "https://hogsend.com/:path*",
        permanent: true,
      },
      {
        source: "/docs/installation",
        destination: "/docs/getting-started/installation",
        permanent: true,
      },
      {
        source: "/docs/posthog-setup",
        destination: "/docs/getting-started/posthog-setup",
        permanent: true,
      },
      {
        source: "/docs/how-it-works",
        destination: "/docs/concepts/how-it-works",
        permanent: true,
      },
      {
        source: "/docs/why-posthog",
        destination: "/docs/concepts/why-posthog",
        permanent: true,
      },
      {
        source: "/docs/why-hatchet",
        destination: "/docs/concepts/why-hatchet",
        permanent: true,
      },
      {
        source: "/docs/philosophy",
        destination: "/docs/concepts/philosophy",
        permanent: true,
      },
      {
        source: "/docs/journeys",
        destination: "/docs/guides/journeys",
        permanent: true,
      },
      {
        source: "/docs/events",
        destination: "/docs/guides/events",
        permanent: true,
      },
      {
        source: "/docs/email",
        destination: "/docs/guides/email",
        permanent: true,
      },
      {
        source: "/docs/conditions",
        destination: "/docs/guides/conditions",
        permanent: true,
      },
      {
        source: "/docs/security",
        destination: "/docs/operating/authentication",
        permanent: true,
      },
      {
        source: "/docs/alerting",
        destination: "/docs/operating/monitoring",
        permanent: true,
      },
      {
        source: "/docs/deployment",
        destination: "/docs/operating/deployment",
        permanent: true,
      },
      {
        source: "/docs/metrics",
        destination: "/docs/operating/metrics",
        permanent: true,
      },
      {
        source: "/docs/bulk-operations",
        destination: "/docs/operating/bulk-operations",
        permanent: true,
      },
      {
        source: "/docs/api-reference",
        destination: "/docs/api",
        permanent: true,
      },
      {
        source: "/docs/admin",
        destination: "/docs/operating",
        permanent: true,
      },
      {
        source: "/docs/admin/authentication",
        destination: "/docs/operating/authentication",
        permanent: true,
      },
      {
        source: "/docs/admin/contacts",
        destination: "/docs/operating/contacts",
        permanent: true,
      },
      {
        source: "/docs/admin/journeys",
        destination: "/docs/operating/journeys",
        permanent: true,
      },
      {
        source: "/docs/admin/emails",
        destination: "/docs/operating/emails",
        permanent: true,
      },
      {
        source: "/docs/admin/monitoring",
        destination: "/docs/operating/monitoring",
        permanent: true,
      },
    ];
  },
};

// withInspector adds the dev-only source-stamping loader (no-op in production).
export default withInspector(withMDX(config), {
  include: ["/components/landing/"],
});
