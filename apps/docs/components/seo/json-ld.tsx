import type { JSX } from "react";
import {
  CONTACT_EMAIL,
  ENGINE_VERSION,
  GITHUB_URL,
  LINKEDIN_URL,
  NPM_URL,
  SITE_URL,
  WITHSEISMIC_URL,
} from "@/lib/site";

/**
 * Renders a schema.org JSON-LD block. Server-safe: the payload is serialized
 * once at render time. Keep the data mirrored to visible page copy verbatim.
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

/** Sitewide SoftwareApplication schema — rendered once in app/layout.tsx. */
export function SoftwareApplicationJsonLd(): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: "Hogsend",
        applicationCategory: "DeveloperApplication",
        operatingSystem: "Self-hosted (Node.js 22, Docker, Railway)",
        softwareVersion: ENGINE_VERSION,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        license: `${GITHUB_URL}/blob/main/LICENSE`,
        url: SITE_URL,
        sameAs: [GITHUB_URL, NPM_URL],
        description:
          "Lifecycle automation in TypeScript for product-led teams. Durable journeys live in your repo, work with coding agents, and run across email, in-app, SMS, Discord, and more.",
      }}
    />
  );
}

/** Sitewide Organization schema — rendered once in app/layout.tsx. */
export function OrganizationJsonLd(): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "Organization",
        name: "Hogsend",
        url: SITE_URL,
        founder: {
          "@type": "Person",
          name: "Doug Silkstone",
          url: WITHSEISMIC_URL,
          sameAs: [WITHSEISMIC_URL, LINKEDIN_URL],
        },
        email: CONTACT_EMAIL,
        sameAs: [GITHUB_URL, NPM_URL, WITHSEISMIC_URL, LINKEDIN_URL],
      }}
    />
  );
}

/**
 * Sitewide WebSite schema — rendered once in app/layout.tsx. Declares the
 * canonical site name so search engines can surface "Hogsend" as the source.
 */
export function WebSiteJsonLd(): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "WebSite",
        name: "Hogsend",
        url: SITE_URL,
        publisher: {
          "@type": "Organization",
          name: "Hogsend",
          url: SITE_URL,
        },
      }}
    />
  );
}

export type FaqJsonLdItem = {
  question: string;
  /** Plain-text answer — mirror the visible accordion copy verbatim. */
  answer: string;
};

/**
 * FAQPage schema helper for pages that render an FAQ accordion. Pass the
 * exact question/answer strings shown on the page.
 *
 * Usage (in a page file):
 *   <FaqPageJsonLd items={FAQ_ITEMS} />
 */
export function FaqPageJsonLd({
  items,
}: {
  items: ReadonlyArray<FaqJsonLdItem>;
}): JSX.Element {
  return (
    <JsonLd
      data={{
        "@context": "https://schema.org",
        "@type": "FAQPage",
        mainEntity: items.map((item) => ({
          "@type": "Question",
          name: item.question,
          acceptedAnswer: { "@type": "Answer", text: item.answer },
        })),
      }}
    />
  );
}
