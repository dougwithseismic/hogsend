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
import { CodeHighlight } from "@/components/ds/code-highlight";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { type StackItem, StackPicker } from "@/components/landing/stack-picker";

export const metadata: Metadata = {
  title: "Integrations",
  description:
    "PostHog is the default source. Events also flow in from signed webhooks (Stripe, Clerk, Supabase, Segment), your own app, or any custom source, and fan back out to PostHog, Segment, Slack, your CRM, your warehouse, or any signed webhook.",
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
      "One command after deploy. hogsend connect posthog opens a single browser consent, wires person reads, and provisions the PostHog → Hogsend webhook for you — or set the keys yourself if you prefer.",
    tag: "hogsend connect posthog",
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
 * Stack picker snippets — each condensed from the real docs page it links
 * to. URLs, header names, env vars, and event names are verbatim from the
 * docs; nothing here is invented.
 */
const STACK_SNIPPETS: Record<string, string> = {
  // The one-command connect; manual wiring stays documented at
  // content/docs/getting-started/posthog-setup.mdx
  posthog: `# The scaffold asks "Are you using PostHog?" and writes
#   POSTHOG_API_KEY · POSTHOG_HOST · a minted webhook secret
#   — and enables the outbound PostHog destination.

# Once deployed, one command finishes the loop:
$ hogsend connect posthog

# One browser consent (OAuth, PKCE). The credential is stored
# encrypted server-side; person reads are wired (timezones,
# property conditions) and the PostHog → Hogsend webhook is
# provisioned for you — idempotent, adopts an existing one.

# Self-hosted PostHog, or no OAuth? Use a personal key
# scoped to person:read + project:read instead.`,

  // From content/docs/integrations/segment.mdx
  segment: `# Segment → Connections → Destinations → Webhooks (Actions)
#   URL     https://api.hogsend.com/v1/webhooks/segment
#   Header  x-signature — HMAC-SHA256 hex of the raw body
#   Secret  the same value on both sides

# Hogsend .env — enables the preset and verifies signatures
SEGMENT_WEBHOOK_SECRET=your-segment-shared-secret

# identify → contact.updated (traits merge onto the contact)
# track "Order Completed" → event "Order Completed", name as-is
# page / screen / group / alias → skipped (200, skipped: true)`,

  // From content/docs/integrations/stripe.mdx
  stripe: `# Stripe → Developers → Webhooks → Add endpoint
#   URL  https://api.hogsend.com/v1/webhooks/stripe
#   Subscribe to customer.created at minimum, plus the
#   subscription / invoice events you trigger on.

# Hogsend .env — the endpoint's signing secret
STRIPE_WEBHOOK_SECRET=whsec_...

# Verifies the stripe-signature header itself (HMAC-SHA256,
# 5-minute tolerance) — no Stripe SDK required.
# customer.created          → contact.created
# customer.subscription.<x> → subscription.<x>
# invoice.<x>               → invoice.<x>  (invoice.payment_failed)`,

  // From content/docs/integrations/clerk.mdx
  clerk: `# Clerk Dashboard → Webhooks → Add Endpoint
#   URL  https://api.hogsend.com/v1/webhooks/clerk
#   Subscribe: user.created, user.updated, user.deleted,
#   waitlistEntry.created

# Hogsend .env — the endpoint's signing secret
CLERK_WEBHOOK_SECRET=whsec_...

# Deliveries are Svix-signed — svix-id / svix-timestamp /
# svix-signature are verified before the payload is processed.
# user.created          → contact.created
# user.updated          → contact.updated
# waitlistEntry.created → waitlist.joined`,

  // From content/docs/integrations/supabase.mdx
  supabase: `# Supabase → Database → Webhooks → Create a new hook
#   Table   auth.users · Events: Insert, Update, Delete
#   Type    HTTP Request · Method POST
#   URL     https://api.hogsend.com/v1/webhooks/supabase
#   Header  x-supabase-webhook-secret: <same value as below>

# Hogsend .env — mounts the preset; fail-closed without it
SUPABASE_WEBHOOK_SECRET=whsec_your_secret_value

# INSERT → contact.created · UPDATE → contact.updated
# DELETE → contact.deleted
# raw_user_meta_data merges onto the contact record.`,
};

const STACK_ITEMS: StackItem[] = [
  {
    id: "posthog",
    label: "PostHog",
    brand: "posthog",
    blurb:
      "One command and one browser consent — hogsend connect posthog wires person reads and the webhook loop. The inbound source is still scaffold code you own.",
    guideHref: "/docs/getting-started/posthog-setup",
    snippet: <CodeHighlight code={STACK_SNIPPETS.posthog ?? ""} lang="bash" />,
  },
  {
    id: "segment",
    label: "Segment",
    brand: "segment",
    blurb:
      "A Webhooks (Actions) destination. identify and track calls become contacts and events; everything else is skipped.",
    guideHref: "/docs/integrations/segment",
    snippet: <CodeHighlight code={STACK_SNIPPETS.segment ?? ""} lang="bash" />,
  },
  {
    id: "stripe",
    label: "Stripe",
    brand: "stripe",
    blurb:
      "A built-in preset. Set the signing secret and billing events become journey triggers — no SDK, no handler.",
    guideHref: "/docs/integrations/stripe",
    snippet: <CodeHighlight code={STACK_SNIPPETS.stripe ?? ""} lang="bash" />,
  },
  {
    id: "clerk",
    label: "Clerk",
    blurb:
      "A built-in, Svix-verified preset. User lifecycle and waitlist events normalise into Hogsend's contact vocabulary.",
    guideHref: "/docs/integrations/clerk",
    snippet: <CodeHighlight code={STACK_SNIPPETS.clerk ?? ""} lang="bash" />,
  },
  {
    id: "supabase",
    label: "Supabase",
    blurb:
      "A built-in preset watching auth.users. Signups, profile changes, and deletions become contact lifecycle events.",
    guideHref: "/docs/integrations/supabase",
    snippet: <CodeHighlight code={STACK_SNIPPETS.supabase ?? ""} lang="bash" />,
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
              title="Sources in, destinations out"
              subtitle="Events flow in from signed webhooks, your own app, or any custom source, and fan back out to the tools you already run. PostHog is the default source; every other wire in and out is configuration."
            />
          </Reveal>
        </div>
      </section>

      {/* Stack picker — pick a source, see the real wiring. */}
      <Section id="stack">
        <Reveal>
          <SectionHeading
            eyebrow="Pick your stack"
            title="See the actual wiring"
            subtitle="Select a source. Each snippet is the real setup — the URL, the header, the secret — condensed from its docs page. Most of these are one env var and a webhook form."
          />
        </Reveal>

        <Reveal delay={0.1}>
          <StackPicker items={STACK_ITEMS} className="mt-12 md:mt-16" />
        </Reveal>
      </Section>

      {/* Sources — events in. Full-bleed top hairline via Section. */}
      <Section id="sources">
        <Reveal>
          <SectionHeading
            eyebrow="Sources — events in"
            title="Everything your users do, in one stream"
            subtitle="One command connects PostHog; four signed-webhook presets auto-enable the moment you set their secret — no handler, no glue. Or send from your own code, or define a source of your own."
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
