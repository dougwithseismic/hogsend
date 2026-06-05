/**
 * Pure schema.org structured-data builders. Each function returns a plain,
 * JSON-serializable object with an `@context` of "https://schema.org", ready to
 * hand to `<JsonLd data={...} />`. No side effects — safe to call on the server
 * during render. All URLs derive from `lib/site.ts` (single source).
 */

import type { FaqItem } from "@/lib/faq-data";
import {
  GITHUB_URL,
  NPM_URL,
  OG_IMAGE,
  SITE_DESCRIPTION,
  SITE_NAME,
  SITE_URL,
} from "@/lib/site";

/** schema.org Organization — the Hogsend project itself. */
export function organization() {
  return {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: SITE_NAME,
    url: SITE_URL,
    logo: `${SITE_URL}${OG_IMAGE}`,
    description: SITE_DESCRIPTION,
    sameAs: [GITHUB_URL, NPM_URL],
  };
}

/** schema.org WebSite — with a docs SearchAction for sitelinks search box. */
export function website() {
  return {
    "@context": "https://schema.org",
    "@type": "WebSite",
    name: SITE_NAME,
    url: SITE_URL,
    description: SITE_DESCRIPTION,
    potentialAction: {
      "@type": "SearchAction",
      target: {
        "@type": "EntryPoint",
        urlTemplate: `${SITE_URL}/docs?q={search_term_string}`,
      },
      "query-input": "required name=search_term_string",
    },
  };
}

/** schema.org SoftwareApplication — Hogsend as a free, open-source dev tool. */
export function softwareApplication() {
  return {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: SITE_NAME,
    applicationCategory: "DeveloperApplication",
    operatingSystem: "Node.js",
    description: SITE_DESCRIPTION,
    url: SITE_URL,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
    },
  };
}

/** schema.org FAQPage — maps `{ q, a }` items to Question/Answer entities. */
export function faqPage(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: {
        "@type": "Answer",
        text: item.a,
      },
    })),
  };
}

/** schema.org BreadcrumbList — ordered trail of `{ name, url }` crumbs. */
export function breadcrumb(items: { name: string; url: string }[]) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: item.url,
    })),
  };
}

/** schema.org TechArticle — for a single docs page. */
export function techArticle({
  title,
  description,
  url,
  datePublished,
}: {
  title: string;
  description: string;
  url: string;
  datePublished?: string;
}) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    headline: title,
    description,
    url,
    ...(datePublished ? { datePublished } : {}),
    author: {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
    },
    publisher: {
      "@type": "Organization",
      name: SITE_NAME,
      url: SITE_URL,
      logo: {
        "@type": "ImageObject",
        url: `${SITE_URL}${OG_IMAGE}`,
      },
    },
  };
}
