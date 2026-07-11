import type { JSX } from "react";
import {
  CONTACT_EMAIL,
  GITHUB_URL,
  HOGSEND_URL,
  LINKEDIN_URL,
  SITE_URL,
  WITHSEISMIC_URL,
} from "@/lib/site";

/**
 * Renders a schema.org JSON-LD block. Server-safe: the payload is serialized
 * once at render time. Keep the data mirrored to visible page copy verbatim.
 * Mirrors apps/docs/components/seo/json-ld.tsx.
 */
export function JsonLd({
  data,
}: {
  data: Record<string, unknown>;
}): JSX.Element {
  return (
    <script
      type="application/ld+json"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: JSON-LD requires a raw script body; the payload is JSON.stringify-escaped, never user input.
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}

/** The publisher/provider node reused across every schema on the site. */
const HOGSEND_ORG = {
  "@type": "Organization",
  name: "Hogsend",
  url: HOGSEND_URL,
  sameAs: [GITHUB_URL, WITHSEISMIC_URL, LINKEDIN_URL],
} as const;

/** Sitewide Organization schema — rendered once in app/layout.tsx. */
export function OrganizationJsonLd(): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        ...HOGSEND_ORG,
        email: CONTACT_EMAIL,
        founder: {
          "@type": "Person",
          name: "Doug Silkstone",
          url: WITHSEISMIC_URL,
          sameAs: [WITHSEISMIC_URL, LINKEDIN_URL],
        },
      }}
    />
  );
}

/** Sitewide WebSite schema — rendered once in app/layout.tsx. */
export function WebSiteJsonLd(): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Hogsend Courses",
        url: SITE_URL,
        publisher: HOGSEND_ORG,
      }}
    />
  );
}
