import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { FaqAccordion } from "@/components/ds/faq";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";

const FAQ_ITEMS = [
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

export function Faq() {
  return (
    <Section tone="light" id="faq">
      <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] lg:gap-16">
        <Reveal className="lg:sticky lg:top-28 lg:self-start">
          <Eyebrow tone="light" className="mb-5">
            FAQ
          </Eyebrow>
          <h2 className="max-w-md font-display text-3xl leading-[1.08] text-black md:text-5xl">
            Questions, answered
          </h2>
          <p className="mt-6 max-w-sm text-base text-black/60">
            Still curious? Read the docs.
          </p>
          <div className="mt-6">
            <Button href="/docs" variant="solid" tone="light">
              Read the docs
            </Button>
          </div>
        </Reveal>

        <Reveal delay={0.1}>
          <FaqAccordion items={FAQ_ITEMS} tone="light" />
        </Reveal>
      </div>
    </Section>
  );
}
