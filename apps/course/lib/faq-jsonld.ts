/**
 * FAQPage structured data mirroring a visible FaqAccordion verbatim. Lives in
 * lib (not components/ds/faq.tsx) because the accordion is a client component
 * and this helper is called from server pages.
 */

export type FaqItem = { q: string; a: string };

export function faqPageJsonLd(items: FaqItem[]) {
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: items.map((item) => ({
      "@type": "Question",
      name: item.q,
      acceptedAnswer: { "@type": "Answer", text: item.a },
    })),
  };
}
