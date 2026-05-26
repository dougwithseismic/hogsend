import { createMDX } from "fumadocs-mdx/next";

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  async redirects() {
    return [
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

export default withMDX(config);
