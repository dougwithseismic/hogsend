import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Eyebrow, TagPill } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { AuroraBeam, DotGrid } from "@/components/ds/fx";
import { ProcessSteps } from "@/components/ds/process";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { GITHUB_URL, RAILWAY_DEPLOY_URL, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "13 React Email templates, in your repo",
  description:
    "Every Hogsend scaffold ships 13 production lifecycle templates — onboarding, trials, win-back, digests — as React Email + Tailwind components you own.",
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

type TemplateEntry = {
  /** Basename shared by the screenshot png and the source tsx. */
  name: string;
  blurb: string;
};

type StageGroup = {
  stage: string;
  /** Per-card second link (recipe or use-case page). */
  link: { label: string; href: string };
  /** Optional extra link shown in the group header. */
  headerLink?: { label: string; href: string };
  entries: TemplateEntry[];
};

const GROUPS: StageGroup[] = [
  {
    stage: "Activation",
    link: { label: "Recipe", href: "/docs/recipes/lifecycle-journeys" },
    headerLink: {
      label: "Onboarding use case",
      href: "/use-cases/onboarding",
    },
    entries: [
      {
        name: "activation-quickstart",
        blurb: "Day one: the shortest path to a first win.",
      },
      {
        name: "activation-nudge",
        blurb: "For the user who signed up and went quiet.",
      },
      {
        name: "activation-feature-highlight",
        blurb: "One feature, one reason to come back.",
      },
      {
        name: "activation-community",
        blurb: "Pull new users into your Slack or Discord.",
      },
    ],
  },
  {
    stage: "Conversion",
    link: { label: "Use case", href: "/use-cases/trial-conversion" },
    entries: [
      {
        name: "conversion-usage-milestone",
        blurb: "The upgrade ask, timed to the moment of value.",
      },
      {
        name: "conversion-trial-expiring",
        blurb: "Days-left honesty without countdown theatrics.",
      },
      {
        name: "conversion-winback-offer",
        blurb: "A concrete offer for a lapsed account.",
      },
    ],
  },
  {
    stage: "Retention",
    link: { label: "Recipe", href: "/docs/recipes/marketing-campaigns" },
    entries: [
      {
        name: "retention-weekly-digest",
        blurb: "The week's activity, summarized.",
      },
      {
        name: "retention-achievement",
        blurb: "Milestones worth an email, nothing that isn't.",
      },
    ],
  },
  {
    stage: "Reactivation",
    link: { label: "Use case", href: "/use-cases/winback" },
    entries: [
      {
        name: "reactivation-checkin",
        blurb: "The gentle “still there?”",
      },
      {
        name: "reactivation-final-nudge",
        blurb: "The last email before you stop sending. (And you should stop.)",
      },
    ],
  },
  {
    stage: "Churn prevention",
    link: { label: "Recipe", href: "/docs/recipes/transactional-emails" },
    entries: [
      {
        name: "churn-payment-failed",
        blurb: "Dunning that sounds like a person, not a billing system.",
      },
    ],
  },
  {
    stage: "Feedback",
    link: { label: "Recipe", href: "/docs/recipes/events-and-contacts" },
    entries: [
      {
        name: "feedback-nps-survey",
        blurb: "One click, one number, done.",
      },
    ],
  },
];

function sourceUrl(name: string): string {
  return `${GITHUB_URL}/blob/main/apps/api/src/emails/${name}.tsx`;
}

const TEMPLATE_COUNT = GROUPS.reduce(
  (total, group) => total + group.entries.length,
  0,
);

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "CollectionPage",
  name: "13 React Email templates, in your repo",
  description:
    "Every Hogsend scaffold ships 13 production lifecycle templates — onboarding, trials, win-back, digests — as React Email + Tailwind components you own.",
  url: `${SITE_URL}/emails`,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: TEMPLATE_COUNT,
    itemListElement: GROUPS.flatMap((group) => group.entries).map(
      (entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.name,
        url: sourceUrl(entry.name),
      }),
    ),
  },
};

type TemplateCardProps = {
  entry: TemplateEntry;
  stage: string;
  link: StageGroup["link"];
  index: number;
};

/**
 * Gallery card: screenshot in a dark glass panel floating over a red
 * atmosphere gradient (crimzon feature-card treatment), mono template name,
 * stage chip, one-liner, source + recipe links.
 */
function TemplateCard({ entry, stage, link, index }: TemplateCardProps) {
  return (
    <Reveal delay={(index % 3) * 0.08} className="h-full">
      <Card className="flex h-full flex-col gap-4">
        <div className="-mx-6 -mt-6 relative h-60 shrink-0 overflow-hidden rounded-t-md border-white/[0.08] border-b">
          {/* Red atmosphere backdrop — pure CSS, never a copied asset. */}
          <div
            aria-hidden="true"
            className="absolute inset-0"
            style={{
              background:
                "radial-gradient(120% 100% at 50% 115%, rgba(246, 72, 56, 0.5), rgba(246, 72, 56, 0.12) 48%, rgba(5, 1, 1, 0) 80%), #070202",
            }}
          />
          {/* Dark glass panel hosting the screenshot, clipped at the card
              edge so the mock appears to float up out of the atmosphere. */}
          <div className="absolute inset-x-7 top-7 bottom-0 overflow-hidden rounded-t-[10px] border border-white/10 border-b-0 bg-[#0a0606] shadow-[0_24px_60px_rgba(0,0,0,0.5)]">
            <Image
              src={`/images/emails/${entry.name}.png`}
              alt={`${entry.name} email template preview`}
              fill
              sizes="(min-width: 1024px) 347px, (min-width: 640px) 50vw, 100vw"
              className="object-cover object-top"
            />
          </div>
        </div>

        <div className="flex items-start justify-between gap-3">
          <h3 className="break-all font-mono text-[15px] text-white leading-6">
            {entry.name}
          </h3>
          <TagPill className="shrink-0">{stage}</TagPill>
        </div>

        <p className="text-base text-white/60 leading-6">{entry.blurb}</p>

        <div className="mt-auto flex items-center gap-5 pt-1 text-sm tracking-[-0.02em]">
          <a
            href={sourceUrl(entry.name)}
            target="_blank"
            rel="noreferrer"
            className="text-white/80 transition-colors hover:text-white"
          >
            View source →
          </a>
          <Link
            href={link.href}
            className="text-white/80 transition-colors hover:text-white"
          >
            {link.label} →
          </Link>
        </div>
      </Card>
    </Reveal>
  );
}

export default function EmailsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      {/* Header */}
      <Section divider={false} containerClassName="pt-32 pb-20">
        <AuroraBeam />
        <Reveal className="relative flex flex-col items-center text-center">
          <Eyebrow className="mb-5">Templates</Eyebrow>
          <h1 className="max-w-3xl font-display font-medium text-5xl text-white leading-[1.02] tracking-[-0.05em] md:text-[64px]">
            Thirteen templates, already in your repo
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Every scaffold ships 13 production React Email + Tailwind templates
            — TypeScript components you own, not rows in our database. Edit them
            in your editor, preview them in Studio, review them in a PR.
          </p>
        </Reveal>
      </Section>

      {/* Gallery, grouped by lifecycle stage */}
      <Section>
        <div className="flex flex-col gap-20">
          {GROUPS.map((group) => (
            <div key={group.stage}>
              <Reveal>
                <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2 border-white/[0.08] border-b pb-5">
                  <div className="flex items-baseline gap-4">
                    <h2 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                      {group.stage}
                    </h2>
                    <span className="eyebrow text-white/50">
                      {group.entries.length}{" "}
                      {group.entries.length === 1 ? "template" : "templates"}
                    </span>
                  </div>
                  {group.headerLink ? (
                    <Link
                      href={group.headerLink.href}
                      className="text-sm text-white/60 tracking-[-0.02em] transition-colors hover:text-white"
                    >
                      {group.headerLink.label} →
                    </Link>
                  ) : null}
                </div>
              </Reveal>

              <div className="mt-6 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
                {group.entries.map((entry, index) => (
                  <TemplateCard
                    key={entry.name}
                    entry={entry}
                    stage={group.stage}
                    link={group.link}
                    index={index}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </Section>

      {/* How templates work */}
      <Section>
        <Reveal>
          <ProcessSteps
            eyebrow="How templates work"
            title="Components in, HTML out"
            subtitle={
              <>
                Everything between your editor and the inbox is engine plumbing.{" "}
                <Link
                  href="/docs/guides/email"
                  className="text-white/80 transition-colors hover:text-white"
                >
                  Email guide →
                </Link>{" "}
                <Link
                  href="/docs/data-api/emails"
                  className="text-white/80 transition-colors hover:text-white"
                >
                  Transactional email API →
                </Link>{" "}
                <Link
                  href="/docs/operating/studio"
                  className="text-white/80 transition-colors hover:text-white"
                >
                  Studio →
                </Link>
              </>
            }
            steps={[
              {
                n: "01",
                title: "Your editor is the editor",
                description:
                  "Templates are React Email + Tailwind components in src/emails/ — edit them like any component. Studio previews them with live props and per-template stats. It doesn't edit them. Your editor does — that's the point.",
              },
              {
                n: "02",
                title: "The engine does the plumbing",
                description:
                  "The engine renders React → HTML, rewrites links for first-party tracking, checks preferences, then hands plain HTML to your provider.",
              },
              {
                n: "03",
                title: "Send from a journey or the API",
                description:
                  "Send one from a journey with sendEmail(), or transactionally via POST /v1/emails.",
              },
            ]}
          />
        </Reveal>
      </Section>

      {/* Closing CTA */}
      <Section>
        <DotGrid />
        <Reveal className="relative flex flex-col items-center text-center">
          <Eyebrow className="mb-5">Get started</Eyebrow>
          <h2 className="max-w-2xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            Thirteen templates, one command
          </h2>
          <p className="mt-5 max-w-xl text-base text-white/70 leading-6">
            The scaffold puts all 13 templates — plus 10 journeys, Docker, and
            env — in a repo you own. Edit the first one tonight.
          </p>

          <div className="mt-10 flex w-full max-w-xl items-center justify-between gap-4 rounded-[10px] border border-white/10 bg-[#0a0606] px-4 py-3.5">
            <code className="overflow-x-auto whitespace-nowrap font-mono text-sm text-white/80">
              {SCAFFOLD_COMMAND}
            </code>
            <CopyButton value={SCAFFOLD_COMMAND} />
          </div>

          <div className="mt-8 flex flex-wrap items-center justify-center gap-x-7 gap-y-4">
            <Button href="/docs/getting-started" variant="accent" icon>
              Start building
            </Button>
            <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
              Deploy on Railway
            </Button>
            <Link
              href="/docs"
              className="text-sm text-white/60 tracking-[-0.02em] transition-colors hover:text-white"
            >
              or read the docs first →
            </Link>
          </div>

          <p className="eyebrow mt-8 text-white/40">
            Free to self-host · One scaffold command · 3 env vars on Railway
          </p>
        </Reveal>
      </Section>
    </main>
  );
}
