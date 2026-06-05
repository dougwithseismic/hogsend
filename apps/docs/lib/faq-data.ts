/**
 * The home-page FAQ content — a single source consumed by both the rendered
 * accordion (`components/landing/faq.tsx`) and the FAQPage JSON-LD builder
 * (`faqPage` in `lib/structured-data.ts`). Each item is a `{ q, a }` pair.
 */

export type FaqItem = {
  q: string;
  a: string;
};

export const FAQ_ITEMS: FaqItem[] = [
  {
    q: "Do I need to replace PostHog or Resend?",
    a: "No. Hogsend sits between them — it reads PostHog events and sends through Resend. Nothing to rip out.",
  },
  {
    q: "Is it really just TypeScript?",
    a: "Yes. Journeys and buckets are plain functions with normal control flow — no YAML, no drag-and-drop canvas.",
  },
  {
    q: "Can I self-host it?",
    a: "That's the default. Run it with Docker or deploy to Railway in one click. Your data stays in your own database.",
  },
  {
    q: "What if I outgrow it?",
    a: "You own a clean event model and proven journeys. Extend the engine, patch it, or eject to fully own the code.",
  },
  {
    q: "Does it work without PostHog?",
    a: "PostHog is the primary source, but any system that can send an HTTP webhook (Stripe, your API) can feed events in.",
  },
];
