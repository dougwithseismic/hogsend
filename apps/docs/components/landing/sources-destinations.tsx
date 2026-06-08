import { Inbox, Send, Workflow } from "lucide-react";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

const SOURCES = [
  "PostHog webhooks",
  "Stripe, Clerk, Supabase, Segment — signed presets",
  "Your own app — @hogsend/client + POST /v1/events",
  "Anything else — defineWebhookSource()",
];

const DESTINATIONS = [
  "PostHog",
  "Segment",
  "Slack",
  "A CRM or your data warehouse",
  "Any signed webhook — defineDestination()",
];

function FlowList({ items }: { items: string[] }) {
  return (
    <ul className="mt-4 flex flex-col gap-3 text-black/70 text-sm">
      {items.map((item) => (
        <li key={item} className="flex gap-2.5">
          <span
            aria-hidden
            className="mt-2 size-1.5 shrink-0 rounded-full bg-black/30"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Sources & destinations" — the inbound → react → outbound story that the
 * PostHog-first framing hides. Events in from anywhere, journeys + buckets
 * react, every signal fans back out. Light section, In | engine | Out.
 */
export function SourcesDestinations() {
  return (
    <Section tone="light" id="sources-destinations">
      <Reveal>
        <SectionHeading
          tone="light"
          eyebrow="SOURCES & DESTINATIONS"
          title="PostHog is where you start, not where you stop"
          subtitle="Events flow in from anywhere, your journeys and buckets react in code, and every send and signal fans back out to the tools you already use."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 items-stretch gap-5 md:mt-16 lg:grid-cols-[1fr_auto_1fr]">
        <Reveal>
          <Card tone="light" ticks className="h-full">
            <div className="flex items-center gap-2.5">
              <Inbox size={18} strokeWidth={1.5} />
              <h3 className="font-display text-lg">Events in</h3>
            </div>
            <FlowList items={SOURCES} />
          </Card>
        </Reveal>

        <Reveal delay={0.08} className="flex items-center justify-center">
          <div className="flex items-center gap-2 rounded-[10px] border border-black/10 bg-white px-4 py-3">
            <Workflow size={18} strokeWidth={1.5} />
            <span className="font-mono text-xs uppercase tracking-wide">
              Journeys + Buckets
            </span>
          </div>
        </Reveal>

        <Reveal delay={0.16}>
          <Card tone="light" ticks className="h-full">
            <div className="flex items-center gap-2.5">
              <Send size={18} strokeWidth={1.5} />
              <h3 className="font-display text-lg">Events out</h3>
            </div>
            <FlowList items={DESTINATIONS} />
          </Card>
        </Reveal>
      </div>

      <Reveal delay={0.1}>
        <div className="mt-10 flex justify-center">
          <Button href="/integrations" variant="outline" tone="light">
            See all integrations
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}
