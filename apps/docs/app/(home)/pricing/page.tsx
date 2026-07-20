import { Check, X } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Eyebrow, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { FaqAccordion } from "@/components/ds/faq";
import { AuroraBeam, DotGrid } from "@/components/ds/fx";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { ThermalHover } from "@/components/ds/thermal";
import { PricingCalculator } from "@/components/landing/pricing-calculator";
import { SERVICE_LADDER } from "@/lib/pricing";
import { GITHUB_URL, RAILWAY_DEPLOY_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "Pricing: free to self-host, no per-contact billing",
  description:
    "Hogsend is free to self-host under ELv2 — no per-contact, per-profile, or per-send pricing, and no paid tier holding features back. Rather have it built and run for you? That starts with a $2,000 one-week lifecycle audit.",
  alternates: { canonical: "/pricing" },
  keywords: [
    "hogsend pricing",
    "self-hosted email",
    "email automation pricing",
    "no per-contact billing",
    "lifecycle email",
    "managed hosting",
    "marketing automation for developers",
    "code-first",
  ],
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

const TERMINAL_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  { text: SCAFFOLD_COMMAND, tone: "accent" },
];

/* ------------------------------------------------------------------------ */
/*  Copy data                                                                */
/* ------------------------------------------------------------------------ */

// The lean card bullets — the strongest five lines. The full list lives in
// EVERYTHING_ITEMS and renders in the "everything in the box" strip below.
const ZERO_DOLLAR_ITEMS: ReactNode[] = [
  "The engine and all 11 packages",
  "10 production journeys in the scaffold",
  "Durable execution (Hatchet)",
  "First-party open & link tracking",
  <>
    Every future version (
    <code className="font-mono text-sm">pnpm up &quot;@hogsend/*&quot;</code>)
  </>,
];

const EVERYTHING_ITEMS: ReactNode[] = [
  "The engine and all 11 packages",
  "10 production journeys in the scaffold",
  "Journey Blueprints — agent-authored journeys, promotable to code",
  "Buckets, lists, campaigns + broadcasts",
  "Durable execution (Hatchet)",
  "Digest + throttle journey primitives",
  "First-party open & link tracking — vanity links, QR codes, click attribution",
  "Suppression + preference center",
  "13 React Email templates",
  <>
    Data API + <code className="font-mono text-sm">@hogsend/client</code> SDK
  </>,
  "4 signed inbound presets (Stripe, Clerk, Supabase, Segment) + PostHog webhooks + custom sources",
  "Outbound destinations (PostHog, Segment, Slack, signed webhooks)",
  "Studio",
  "CLI + Claude Code skills",
  "MCP server — author journeys from Claude Desktop or claude.ai",
  <>
    Every future version (
    <code className="font-mono text-sm">pnpm up &quot;@hogsend/*&quot;</code>)
  </>,
];

type RentRow = {
  vendor: string;
  chargesBy: string;
  whenYouGrow: string;
  highlight?: boolean;
};

const RENT_ROWS: RentRow[] = [
  {
    vendor: "Loops",
    chargesBy: "subscribed contacts",
    whenYouGrow: "$249/mo at 50k contacts*",
  },
  {
    vendor: "Customer.io",
    chargesBy: "profiles + emails + credits",
    whenYouGrow: "custom pricing at scale",
  },
  {
    vendor: "PostHog Workflows",
    chargesBy: "$0.003/send after 10k free/mo*",
    whenYouGrow: "costs scale with volume",
  },
  {
    vendor: "Hogsend",
    chargesBy: "nothing — it's your infra",
    whenYouGrow: "roughly $20–40/mo of Railway infra at 50k contacts*",
    highlight: true,
  },
];

const COMPARE_LINKS = [
  { label: "Hogsend vs. Loops", href: "/docs/compare/loops" },
  { label: "Hogsend vs. Customer.io", href: "/docs/compare/customer-io" },
  {
    label: "Hogsend vs. PostHog Workflows",
    href: "/docs/compare/posthog-workflows",
  },
];

const LICENSE_CAN = [
  "Use it commercially",
  "Modify it and fork it",
  "Self-host it for your company or your clients",
  "Ship products that depend on it",
];

// Single source for the accordion AND the FAQPage JSON-LD below — keeps the
// structured data mirroring the visible copy verbatim.
const FAQ_ITEMS = [
  {
    q: "Is there a cloud or managed version of Hogsend?",
    a: "There is no multi-tenant cloud, and there never will be one. Hosting and upkeep are included in the Run retainer if I'm operating your program — otherwise you run it yourself, on your own infrastructure. ELv2 means nobody else can sell you a managed Hogsend either.",
  },
  {
    q: "What infrastructure does Hogsend need?",
    a: "Node 22, Postgres (TimescaleDB), Redis, and Hatchet for durable execution. pnpm bootstrap stands all of it up locally in Docker; the Railway template provisions it in production with three required inputs (your Resend API key, a Studio admin email, and a Hatchet client token minted by the bundled Hatchet-Lite service).",
  },
  {
    q: "What happens when my list grows 10x?",
    a: "Your Postgres gets more rows. Costs scale with your traffic and infrastructure, not your contact count.",
  },
  {
    q: "Can I use Hogsend for client work?",
    a: "Yes — consultants deploying Hogsend inside each client's own infrastructure and accounts is exactly the intended use. What ELv2 forbids is operating Hogsend as a multi-tenant managed service you sell access to.",
  },
  {
    q: "Can someone set Hogsend up for me?",
    a: "Yes — that's the service, and it's a three-step ladder. A $2,000 one-week Lifecycle Audit maps where your funnel leaks and gives you a 90-day roadmap you can act on with or without me. A $9,500 30-Day Build ships the journeys, templates, and tracking as TypeScript in your own repo. Run, from $4,000/month, keeps it working and adds new journeys and experiments as your product changes. The audit fee comes off the build if you go ahead.",
  },
  {
    q: "Will features move behind a paid tier later?",
    a: "There is no paid tier, and the published packages are semver-versioned — what you install is yours to run at that version, under the license it shipped with. Today everything is free to self-host, and there is no paid tier on any roadmap we've published.",
  },
];

const FAQ_JSON_LD = {
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: FAQ_ITEMS.map((item) => ({
    "@type": "Question",
    name: item.q,
    acceptedAnswer: { "@type": "Answer", text: item.a },
  })),
};

/* ------------------------------------------------------------------------ */
/*  Shared bits                                                              */
/* ------------------------------------------------------------------------ */

/** The sitewide CTA trio: accent → Railway → docs text link. */
function CtaTrio({ centered = false }: { centered?: boolean }): JSX.Element {
  return (
    <div
      className={
        centered
          ? "flex flex-wrap items-center justify-center gap-x-6 gap-y-4"
          : "flex flex-wrap items-center gap-x-6 gap-y-4"
      }
    >
      <Button href="/docs/getting-started" variant="accent" icon>
        Start building
      </Button>
      <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
        Deploy on Railway
      </Button>
      <Link
        href="/docs"
        className="text-sm text-white/60 transition-colors hover:text-white"
      >
        or read the docs first →
      </Link>
    </div>
  );
}

/** Friction microcopy under a CTA pair — 12px uppercase micro label. */
function Microcopy({ children }: { children: ReactNode }): JSX.Element {
  return <p className="eyebrow mt-5 text-white/50">{children}</p>;
}

/** Accent-bulleted checklist — shared by the plan cards. */
function CheckList({ items }: { items: ReactNode[] }): JSX.Element {
  return (
    <ul className="mt-4 flex flex-col gap-3">
      {items.map((item, index) => (
        <li
          // Static, never-reordered checklist.
          // biome-ignore lint/suspicious/noArrayIndexKey: stable list
          key={index}
          className="flex items-start gap-3 text-base text-white/80 leading-6"
        >
          <Check
            aria-hidden="true"
            className="mt-1 size-4 shrink-0 text-accent"
            strokeWidth={2}
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

/* ------------------------------------------------------------------------ */
/*  Page                                                                     */
/* ------------------------------------------------------------------------ */

export default function PricingPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      {/* ---- 3.1 Hero -------------------------------------------------- */}
      <Section
        divider={false}
        containerClassName="container-page pt-32 pb-20 text-center"
      >
        <AuroraBeam className="opacity-60" />
        <Reveal className="relative z-10 flex flex-col items-center">
          <Eyebrow className="mb-4">Pricing</Eyebrow>
          <h1 className="max-w-3xl font-display text-[36px] text-white leading-[1.15] tracking-[-0.02em] md:text-[44px] md:leading-[52px]">
            Free to self-host. No per-contact billing.
          </h1>
          <p className="mt-5 max-w-2xl text-base text-white/70 leading-6">
            There is no paid tier. You pay for hosting and for your own Resend
            or Postmark account — contact count appears in neither bill. If you
            want the lifecycle program built and run for you instead of building
            it yourself, that&apos;s the{" "}
            <Link
              href="/service"
              className="text-white/90 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              service
            </Link>
            .
          </p>
          <div className="mt-10">
            <CtaTrio centered />
            <Microcopy>
              Free to self-host · One scaffold command · No per-contact billing
            </Microcopy>
          </div>
        </Reveal>
      </Section>

      {/* ---- 3.2 What $0 gets you -------------------------------------- */}
      <Section>
        <SectionHeading
          align="center"
          eyebrow="The software"
          title="What $0 gets you"
          subtitle="Everything. There is no paid tier and nothing is held back — the engine, the scaffold, the tooling, and every release after this one."
        />

        <div className="mx-auto mt-12 max-w-xl">
          <Reveal delay={0.08} className="h-full">
            <ThermalHover className="h-full w-full" rounded="rounded-md">
              <Card className="relative h-full w-full overflow-hidden p-8">
                <div className="relative flex h-full flex-col">
                  <div className="flex items-center justify-between gap-4">
                    <span className="text-base text-white">Self-hosted</span>
                    <TagPill accent>Everything</TagPill>
                  </div>

                  <div className="mt-5 flex items-baseline gap-1.5">
                    <span className="font-display text-[40px] text-white leading-[48px]">
                      $0
                    </span>
                    <span className="text-base text-white/60">/forever</span>
                  </div>

                  <p className="mt-4 text-base text-white/70 leading-6">
                    The engine, the scaffold, the tooling, and every release
                    after this one. You pay for your own hosting and your own
                    email provider. Nothing else.
                  </p>

                  <p className="eyebrow mt-8 text-white/50">
                    What&apos;s included
                  </p>

                  <CheckList items={ZERO_DOLLAR_ITEMS} />

                  <p className="mt-4 text-base text-white/60 leading-6">
                    The full list is below — everything in the box.
                  </p>

                  <p className="mt-4 text-base text-white/60 leading-6">
                    Self-hosting and stuck at the empty-journeys stage? That is
                    exactly what the{" "}
                    <Link
                      href="/service"
                      className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
                    >
                      $2,000 audit
                    </Link>{" "}
                    is for.
                  </p>

                  <div className="mt-auto pt-8">
                    <div className="border-white/[0.08] border-t pt-6">
                      <Button
                        href="/docs/getting-started"
                        variant="accent"
                        icon
                        className="w-full justify-center"
                      >
                        Start building
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            </ThermalHover>
          </Reveal>
        </div>

        {/* The service — priced, in sequence after $0 rather than in a card
            row beside it (a grid would invite "why pay when it's free?"). */}
        <div className="mt-20">
          <SectionHeading
            align="center"
            eyebrow="The service"
            title="The software is free. The work is what costs money."
            subtitle="Or I build it and run it for you. Same software, none of the work — it ships as TypeScript in your own repository, on your own accounts, so you keep all of it either way."
          />

          <Reveal delay={0.08}>
            <div className="mx-auto mt-12 grid max-w-4xl gap-px overflow-hidden rounded-md border border-white/[0.08] bg-white/[0.08] sm:grid-cols-3">
              {SERVICE_LADDER.map((tier) => (
                <div key={tier.id} className="bg-[#0a0a0a] p-6">
                  <p className="eyebrow text-white/50">{tier.name}</p>
                  <div className="mt-3 flex items-baseline gap-1.5">
                    <span className="font-display text-[28px] text-white leading-[34px]">
                      {tier.price}
                    </span>
                    <span className="text-sm text-white/50">{tier.suffix}</span>
                  </div>
                </div>
              ))}
            </div>
          </Reveal>

          <Reveal delay={0.16}>
            <div className="mt-8 flex flex-col items-center gap-4 text-center">
              <p className="mx-auto max-w-2xl text-base text-white/60 leading-6">
                Start with the audit: one week going through your events, your
                emails, and your funnel, and a 90-day roadmap you can act on
                with or without me. Its fee comes off the build if you go ahead.
              </p>
              <Button href="/service" variant="accent" icon>
                See the service
              </Button>
            </div>
          </Reveal>
        </div>

        {/* Everything in the box — the full $0 list, out of the cards. */}
        <div className="mt-20">
          <SectionHeading
            align="center"
            eyebrow="Included"
            title="Everything in the box"
            subtitle="The full $0 list. All of it ships in the free version — there is no paid tier holding any of it back."
          />
          <Reveal delay={0.08}>
            <ul className="mx-auto mt-10 grid max-w-5xl gap-x-10 gap-y-3 sm:grid-cols-2 lg:grid-cols-3">
              {EVERYTHING_ITEMS.map((item, index) => (
                <li
                  // Static, never-reordered checklist.
                  // biome-ignore lint/suspicious/noArrayIndexKey: stable list
                  key={index}
                  className="flex items-start gap-3 text-base text-white/80 leading-6"
                >
                  <Check
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-accent"
                    strokeWidth={2}
                  />
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
      </Section>

      {/* ---- 3.3 Compared + calculator (merged) -------------------------- */}
      <Section>
        <SectionHeading
          eyebrow="Compared"
          title="How the hosted tools price it"
          subtitle="They meter contacts, profiles, or sends. Hogsend runs on your infrastructure, so there is no meter — the table shows their structure, the calculator shows both at your size."
        />

        <Reveal delay={0.08} className="mt-12">
          <div className="overflow-hidden rounded-md border border-white/[0.08]">
            <table className="w-full border-collapse text-left">
              <thead>
                <tr className="border-white/[0.08] border-b">
                  <th className="eyebrow p-5 font-normal text-white/50">
                    <span className="sr-only">Vendor</span>
                  </th>
                  <th className="eyebrow p-5 font-normal text-white/50">
                    They charge by
                  </th>
                  <th className="eyebrow p-5 font-normal text-white/50">
                    When your list grows
                  </th>
                </tr>
              </thead>
              <tbody>
                {RENT_ROWS.map((row) => (
                  <tr
                    key={row.vendor}
                    className={
                      row.highlight
                        ? "border-white/[0.08] border-t bg-accent-tint"
                        : "border-white/[0.08] border-t bg-white/[0.015]"
                    }
                  >
                    <td
                      className={
                        row.highlight
                          ? "p-5 font-medium text-base text-white"
                          : "p-5 text-base text-white/80"
                      }
                    >
                      {row.vendor}
                    </td>
                    <td
                      className={
                        row.highlight
                          ? "p-5 font-medium text-base text-white"
                          : "p-5 text-base text-white/80"
                      }
                    >
                      {row.chargesBy}
                    </td>
                    <td
                      className={
                        row.highlight
                          ? "p-5 font-medium text-base text-white"
                          : "p-5 text-base text-white/80"
                      }
                    >
                      {row.whenYouGrow}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="eyebrow mt-4 text-white/50">
            *List prices at the time of writing — competitor pricing checked
            June 2026, Railway rates July 2026.
          </p>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="mt-10 max-w-3xl text-base text-white/70 leading-6">
            Loops meters subscribed contacts. Customer.io meters profiles,
            emails, and credits. PostHog Workflows is free to 10,000 messages a
            month, then from $0.003 per send (at the time of writing). Those are
            the prices for software they host and run for you. Hogsend runs on
            your own infrastructure — whether you operate it or we do — so there
            is no per-contact or per-send line.
          </p>
        </Reveal>

        {/* At your size — the calculator, merged in under the table. */}
        <div className="mt-20">
          <SectionHeading
            align="center"
            eyebrow="At your size"
            title="Two structures, side by side"
            subtitle="Set your list size and monthly send volume. The left column is a contact-metered platform; the right column is Hogsend."
          />
          <div className="mt-12">
            <PricingCalculator />
          </div>
        </div>

        {/* Real costs, condensed — the whole bill in one paragraph. */}
        <Reveal delay={0.1}>
          <p className="mt-12 max-w-3xl text-base text-white/70 leading-6">
            That&apos;s the whole bill: hosting — the{" "}
            <Link
              href="/docs/operating/deploy-railway"
              className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              one-click Railway template
            </Link>{" "}
            provisions the entire stack for roughly $20–40/month at 5,000–50,000
            contacts, the floor measured on a production instance of ours in
            July 2026 — and your own Resend or Postmark account at their rates.
            There is no Hogsend line item, and contact count meters into neither
            bill.
          </p>

          <p className="mt-8 text-sm text-white/60">
            Their pricing, their words — see the comparisons:{" "}
            {COMPARE_LINKS.map((link, index) => (
              <span key={link.href}>
                {index > 0 ? " · " : null}
                <Link
                  href={link.href}
                  className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
                >
                  {link.label}
                </Link>
              </span>
            ))}
          </p>
          <p className="eyebrow mt-3 text-white/50">
            Competitor pricing last checked June 2026.
          </p>
        </Reveal>
      </Section>

      {/* ---- 3.5 #license ------------------------------------------------ */}
      <Section id="license">
        <SectionHeading
          eyebrow="License"
          title="The license, in plain English"
          subtitle="Elastic License 2.0 — source-available, free to self-host, one restriction."
        />

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          <Reveal delay={0}>
            <Card className="h-full">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                You can
              </h3>
              <ul className="mt-4 flex flex-col gap-3">
                {LICENSE_CAN.map((item) => (
                  <li
                    key={item}
                    className="flex items-start gap-3 text-base text-white/80 leading-6"
                  >
                    <Check
                      aria-hidden="true"
                      className="mt-1 size-4 shrink-0 text-accent"
                      strokeWidth={2}
                    />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 text-base text-white/60 leading-6">Free.</p>
            </Card>
          </Reveal>

          <Reveal delay={0.08}>
            <Card className="h-full">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                You can&apos;t
              </h3>
              <ul className="mt-4 flex flex-col gap-3">
                <li className="flex items-start gap-3 text-base text-white/80 leading-6">
                  <X
                    aria-hidden="true"
                    className="mt-1 size-4 shrink-0 text-white/40"
                    strokeWidth={2}
                  />
                  <span>
                    Offer Hogsend itself to third parties as a managed or hosted
                    service.
                  </span>
                </li>
              </ul>
              <p className="mt-4 text-base text-white/60 leading-6">
                That&apos;s the entire restriction.
              </p>
            </Card>
          </Reveal>

          <Reveal delay={0.16}>
            <Card className="h-full">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                Why ELv2
              </h3>
              <p className="mt-2.5 text-base text-white/60 leading-6">
                It keeps the code open to you and closes the one path where a
                host larger than us resells our work. We call it
                source-available because that&apos;s what it is — it&apos;s not
                OSI-approved open source, and we&apos;d rather say so plainly
                than blur it.
              </p>
              <p className="mt-4 text-base text-white/60 leading-6">
                Full text:{" "}
                <a
                  href={`${GITHUB_URL}/blob/main/LICENSE`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
                >
                  LICENSE on GitHub
                </a>
              </p>
            </Card>
          </Reveal>
        </div>
      </Section>

      {/* ---- 3.6 FAQ ----------------------------------------------------- */}
      <Section>
        <div className="grid gap-12 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          <Reveal>
            <SectionHeading
              eyebrow="FAQ"
              title="Pricing questions"
              subtitle="The short version: there is no meter."
            />
          </Reveal>
          <Reveal delay={0.08}>
            <FaqAccordion items={FAQ_ITEMS} />
          </Reveal>
        </div>

        <script
          type="application/ld+json"
          // FAQPage structured data mirroring the visible accordion verbatim.
          // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD from a local constant
          dangerouslySetInnerHTML={{ __html: JSON.stringify(FAQ_JSON_LD) }}
        />
      </Section>

      {/* ---- 3.7 Closing CTA --------------------------------------------- */}
      <Section>
        <DotGrid />
        <div className="relative z-10 flex flex-col items-center text-center">
          <Reveal className="flex flex-col items-center">
            <Eyebrow className="mb-4">Get started</Eyebrow>
            <h2 className="max-w-2xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              First send in minutes
            </h2>
            <p className="mt-5 max-w-2xl text-base text-white/70 leading-6">
              <code className="font-mono text-sm">{SCAFFOLD_COMMAND}</code>{" "}
              scaffolds the app, Docker, env, and ten journeys — the welcome
              series included. Or deploy the Railway template in a click.
            </p>
          </Reveal>

          <Reveal delay={0.1} className="mt-10 w-full max-w-xl">
            <div className="relative">
              <CodeMock
                lines={TERMINAL_LINES}
                filename="terminal"
                className="text-left"
              />
              <CopyButton
                value={SCAFFOLD_COMMAND}
                className="absolute top-2 right-3"
              />
            </div>
          </Reveal>

          <Reveal delay={0.18} className="mt-10">
            <CtaTrio centered />
            <Microcopy>
              Free to self-host (ELv2) · PostHog + your provider · No
              per-contact billing
            </Microcopy>
          </Reveal>
        </div>
      </Section>
    </main>
  );
}
