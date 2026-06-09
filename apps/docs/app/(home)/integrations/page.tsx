import {
  Code2,
  Database,
  Lock,
  Shield,
  Users,
  Warehouse,
  Webhook,
} from "lucide-react";
import type { Metadata } from "next";
import type { JSX, ReactNode } from "react";
import { TagPill } from "@/components/ds/badge";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "PostHog is where you start, not where you stop. Events flow in from signed webhooks, your own app, or any custom source — and fan back out to PostHog, Segment, Slack, your CRM, your warehouse, or any signed webhook.",
};

const ICON_SIZE = 20;
const LOGO_HEIGHT = 22;

/**
 * A connector node: either a real masked brand mark (for brands we ship an SVG
 * for) or a lucide icon in the standard 40px square. Used as the top mark on
 * every source/destination card.
 */
type Mark =
  | { kind: "brand"; brand: BrandKey }
  | { kind: "icon"; icon: ReactNode };

function CardMark({ mark }: { mark: Mark }): JSX.Element {
  if (mark.kind === "brand") {
    return (
      <span className="inline-flex h-10 items-center">
        <BrandLogo
          brand={mark.brand}
          height={LOGO_HEIGHT}
          className="text-white/80"
        />
      </span>
    );
  }

  return (
    <span className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/[0.08] bg-white/[0.04] text-white">
      {mark.icon}
    </span>
  );
}

type Connector = {
  mark: Mark;
  title: string;
  description: string;
  /** Small chip describing the wire — e.g. "signed webhook". */
  tag: string;
};

const SOURCES: Connector[] = [
  {
    mark: { kind: "brand", brand: "posthog" },
    title: "PostHog",
    description:
      "Forward PostHog actions and events straight into Hogsend. Set the secret and the signed-webhook preset turns itself on.",
    tag: "signed webhook · preset",
  },
  {
    mark: { kind: "brand", brand: "stripe" },
    title: "Stripe",
    description:
      "Subscriptions, invoices, failed payments — verified Stripe events become journey triggers without writing a handler.",
    tag: "signed webhook · preset",
  },
  {
    mark: { kind: "icon", icon: <Lock size={ICON_SIZE} strokeWidth={1.5} /> },
    title: "Clerk",
    description:
      "Sign-ups, sign-ins, and user changes arrive as verified events. Drop in the signing secret and the preset is live.",
    tag: "signed webhook · preset",
  },
  {
    mark: {
      kind: "icon",
      icon: <Database size={ICON_SIZE} strokeWidth={1.5} />,
    },
    title: "Supabase",
    description:
      "Database webhooks and auth hooks flow in as events you can trigger journeys on — verified the moment the secret is set.",
    tag: "signed webhook · preset",
  },
  {
    mark: { kind: "brand", brand: "segment" },
    title: "Segment",
    description:
      "Pipe your existing Segment track calls in as a source. One secret enables the preset; every event is signature-checked.",
    tag: "signed webhook · preset",
  },
  {
    mark: { kind: "icon", icon: <Code2 size={ICON_SIZE} strokeWidth={1.5} /> },
    title: "Your own app",
    description:
      "Call the @hogsend/client SDK or POST /v1/events directly from your backend. Identify a contact and fire events from anywhere in your stack.",
    tag: "SDK · POST /v1/events",
  },
  {
    mark: {
      kind: "icon",
      icon: <Webhook size={ICON_SIZE} strokeWidth={1.5} />,
    },
    title: "Anything else",
    description:
      "Define a source in TypeScript with defineWebhookSource(): declare auth, validate with Zod, transform the payload, return an event.",
    tag: "defineWebhookSource()",
  },
];

const DESTINATIONS: Connector[] = [
  {
    mark: { kind: "brand", brand: "posthog" },
    title: "PostHog",
    description:
      "Every email and lifecycle event fans back into PostHog as a captured event — so sends, opens, and journey state live next to product analytics.",
    tag: "preset",
  },
  {
    mark: { kind: "brand", brand: "segment" },
    title: "Segment",
    description:
      "Forward the outbound event stream into Segment and let it fan out to the rest of your downstream tools from there.",
    tag: "preset",
  },
  {
    mark: { kind: "brand", brand: "slack" },
    title: "Slack",
    description:
      "Post lifecycle moments — milestones, failed payments, churn signals — straight into a channel as they happen.",
    tag: "preset",
  },
  {
    mark: { kind: "icon", icon: <Users size={ICON_SIZE} strokeWidth={1.5} /> },
    title: "A CRM",
    description:
      "Sync contact and engagement events into your CRM so sales and success see the same lifecycle signals you act on.",
    tag: "defineDestination()",
  },
  {
    mark: {
      kind: "icon",
      icon: <Warehouse size={ICON_SIZE} strokeWidth={1.5} />,
    },
    title: "A warehouse",
    description:
      "Land the raw outbound event stream in your warehouse for modelling, attribution, and reporting alongside the rest of your data.",
    tag: "defineDestination()",
  },
  {
    mark: { kind: "icon", icon: <Shield size={ICON_SIZE} strokeWidth={1.5} /> },
    title: "Any signed webhook",
    description:
      "Define a destination in TypeScript with defineDestination(): pick the events, shape the request, and ship to any HMAC-signed endpoint.",
    tag: "defineDestination()",
  },
];

/**
 * Connector card: a brand mark or icon, a 20px/500 title, a 16px white/60
 * description, and a small 3px-radius wire chip pinned to the bottom. Used in
 * both source/destination grids so the rows read consistently.
 */
function ConnectorCard({ connector }: { connector: Connector }): JSX.Element {
  return (
    <Card className="flex h-full flex-col gap-5">
      <CardMark mark={connector.mark} />

      <div className="flex flex-col gap-2.5">
        <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
          {connector.title}
        </h3>
        <p className="text-base text-white/60 leading-6">
          {connector.description}
        </p>
      </div>

      <span className="mt-auto pt-1">
        <TagPill>{connector.tag}</TagPill>
      </span>
    </Card>
  );
}

function ConnectorGrid({ items }: { items: Connector[] }): JSX.Element {
  return (
    <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
      {items.map((connector, index) => (
        <Reveal key={connector.title} delay={(index % 3) * 0.08}>
          <ConnectorCard connector={connector} />
        </Reveal>
      ))}
    </div>
  );
}

export default function IntegrationsPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* Heading — plain section so pt-32 clears the fixed 80px nav (the
          shared Section rhythm would override it). Sits flush under the nav
          hairline, no divider. */}
      <section className="relative text-white">
        <div className="container-page pt-32 pb-20">
          <Reveal>
            <SectionHeading
              eyebrow="Integrations"
              title="Any source in. Any destination out."
              subtitle="Events flow in from signed webhooks, your own app, or anything you can wire up — and fan back out to the tools you already run. PostHog is where you start, not where you stop."
            />
          </Reveal>
        </div>
      </section>

      {/* Sources — events in. Full-bleed top hairline via Section. */}
      <Section id="sources">
        <Reveal>
          <SectionHeading
            eyebrow="Sources — events in"
            title="Everything your users do, in one stream"
            subtitle="Five signed-webhook presets auto-enable the moment you set their secret — no handler, no glue. Or send from your own code, or define a source of your own."
          />
        </Reveal>

        <ConnectorGrid items={SOURCES} />
      </Section>

      {/* Destinations — events out. */}
      <Section id="destinations">
        <Reveal>
          <SectionHeading
            eyebrow="Destinations — events out"
            title="Every send fans back out"
            subtitle="The outbound event catalog — contact changes, email sends and opens, journey completions, bucket transitions — fans out to the tools you already run, reusing the engine's durable retry, backoff, and DLQ for free."
          />
        </Reveal>

        <ConnectorGrid items={DESTINATIONS} />
      </Section>

      {/* Closing CTA. */}
      <Section id="integrations-cta">
        <Reveal>
          <SectionHeading
            align="center"
            eyebrow="Get started"
            title="Wire up your first connector"
            subtitle="Pick a preset, send from your app, or define your own source and destination in TypeScript."
            className="mx-auto"
          />
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-12 flex flex-wrap items-center justify-center gap-x-8 gap-y-4"
        >
          <Button href="/docs/integrations" variant="accent" icon>
            All integrations
          </Button>
          <Button href="/docs/guides/webhook-sources" variant="outline">
            Webhook sources
          </Button>
          <Button href="/docs/guides/destinations" variant="outline">
            Destinations
          </Button>
        </Reveal>
      </Section>
    </main>
  );
}
