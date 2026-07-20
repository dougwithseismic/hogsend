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
// Disabled for now (see the commented-out usage in TemplateCard):
// import { SampleRequest } from "@/components/landing/sample-request";
import { GITHUB_URL, RAILWAY_DEPLOY_URL, SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  title: "36 React Email templates, in your repo",
  description:
    "36 production lifecycle templates — onboarding, billing, win-back, surveys, QR tickets, impact reports — as React Email + Tailwind components you own. Every one rendered from the live registry.",
  alternates: { canonical: "/emails" },
  keywords: [
    "react email templates",
    "email templates",
    "onboarding emails",
    "trial conversion",
    "win-back emails",
    "lifecycle email",
    "nps email",
    "csat email",
    "dunning email",
    "resend",
    "transactional email",
  ],
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";

type TemplateEntry = {
  /**
   * The template's registry key in apps/api/src/emails/registry.ts — the ONE
   * canonical name. The screenshot png and source tsx use its flat form
   * (slashes → hyphens), and "Email me this one" sends this exact string.
   */
  key: string;
  blurb: string;
};

/** Flat-file form of a registry key: `billing/upcoming-payment` → `billing-upcoming-payment`. */
function flatName(key: string): string {
  return key.replaceAll("/", "-");
}

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
    link: {
      label: "Recipe",
      href: "/recipes/category/onboarding#welcome-series",
    },
    headerLink: {
      label: "Onboarding use case",
      href: "/use-cases/onboarding",
    },
    entries: [
      {
        key: "activation-quickstart",
        blurb: "Day one: the shortest path to a first win.",
      },
      {
        key: "activation-nudge",
        blurb: "For the user who signed up and went quiet.",
      },
      {
        key: "activation-feature-highlight",
        blurb: "One feature, one reason to come back.",
      },
      {
        key: "activation-community",
        blurb: "Pull new users into your Slack or Discord.",
      },
    ],
  },
  {
    stage: "Onboarding",
    link: {
      label: "Play",
      href: "/playbook/second-session-rescue",
    },
    headerLink: {
      label: "Pre-boarding play",
      href: "/playbook/pre-boarding-sequence",
    },
    entries: [
      {
        key: "onboarding/come-back-to-it",
        blurb: "Names the exact step they stopped at.",
      },
      {
        key: "onboarding-personalized",
        blurb:
          "AI-drafted body, on-brand frame — the template keeps it honest.",
      },
      {
        key: "preboarding/manager-welcome",
        blurb: "Keeps a new hire warm between offer and day one.",
      },
    ],
  },
  {
    stage: "Conversion",
    link: {
      label: "Recipe",
      href: "/recipes/category/conversion#trial-conversion-sequence",
    },
    headerLink: {
      label: "Trial conversion use case",
      href: "/use-cases/trial-conversion",
    },
    entries: [
      {
        key: "conversion-usage-milestone",
        blurb: "The upgrade ask, timed to the moment of value.",
      },
      {
        key: "conversion-trial-expiring",
        blurb: "A clear days-left note, without the countdown theatrics.",
      },
      {
        key: "conversion-winback-offer",
        blurb: "A concrete offer for a lapsed account.",
      },
    ],
  },
  {
    stage: "Sales signals",
    link: {
      label: "Play",
      href: "/playbook/proposal-opened-follow-up",
    },
    headerLink: {
      label: "Whitepaper signals play",
      href: "/playbook/whitepaper-reader-signals",
    },
    entries: [
      {
        key: "sales/proposal-opened",
        blurb: "Tells the rep the moment the proposal gets read.",
      },
      {
        key: "sales/whitepaper-follow-up",
        blurb: "For the reader who finished it — straight to pricing.",
      },
    ],
  },
  {
    stage: "Events",
    link: {
      label: "Play",
      href: "/playbook/live-event-summon",
    },
    headerLink: {
      label: "QR tracking play",
      href: "/playbook/direct-mail-qr-codes",
    },
    entries: [
      {
        key: "events/were-live",
        blurb: "One line, one button, sent the minute you go live.",
      },
      {
        key: "events/qr-checkin",
        blurb: "A tracked QR ticket — every scan lands as an event.",
      },
    ],
  },
  {
    stage: "Retention",
    link: {
      label: "Recipe",
      href: "/recipes/category/retention#weekly-digest",
    },
    headerLink: {
      label: "Usage-drop play",
      href: "/playbook/usage-drop-early-warning",
    },
    entries: [
      {
        key: "retention-weekly-digest",
        blurb: "The week's activity, summarized.",
      },
      {
        key: "retention-achievement",
        blurb:
          "Celebrates milestones worth an email, and skips the ones that aren't.",
      },
      {
        key: "retention/founder-checkin",
        blurb: "Plain text from a person, triggered by a usage drop.",
      },
      {
        key: "content/weekly-articles",
        blurb: "The week's publishing, as a short list with read times.",
      },
    ],
  },
  {
    stage: "Accounts & teams",
    link: {
      label: "Play",
      href: "/playbook/weekly-usage-digest",
    },
    entries: [
      {
        key: "groups/account-digest",
        blurb: "One email per account, not per seat.",
      },
      {
        key: "team/invite-teammate",
        blurb: "The invite ask, made with reasons instead of guilt.",
      },
    ],
  },
  {
    stage: "Reactivation",
    link: {
      label: "Recipe",
      href: "/recipes/category/retention#winback-and-sunset",
    },
    headerLink: {
      label: "Win-back play",
      href: "/playbook/dormant-user-winback",
    },
    entries: [
      {
        key: "reactivation-checkin",
        blurb: "The gentle “still there?”",
      },
      {
        key: "winback/whats-new",
        blurb: "What actually changed while they were gone.",
      },
      {
        key: "winback/final-note",
        blurb: "Says it's the last one — and means it.",
      },
      {
        key: "reactivation-final-nudge",
        blurb: "The last email before you stop sending. (And you should stop.)",
      },
    ],
  },
  {
    stage: "Billing & churn",
    link: {
      label: "Recipe",
      href: "/recipes/category/conversion#failed-payment-dunning",
    },
    headerLink: {
      label: "Dunning play",
      href: "/playbook/failed-payment-dunning",
    },
    entries: [
      {
        key: "billing/upcoming-payment",
        blurb: "The renewal heads-up that prevents the dunning email.",
      },
      {
        key: "churn-payment-failed",
        blurb: "Dunning that sounds like a person, not a billing system.",
      },
    ],
  },
  {
    stage: "Feedback",
    link: { label: "Recipe", href: "/recipes/category/retention#nps-survey" },
    entries: [
      {
        key: "feedback-nps-survey",
        blurb: "One click to answer; the score lands as an event.",
      },
      {
        key: "feedback/csat",
        blurb: "Five one-click scores, straight to the person who helped.",
      },
      {
        key: "feedback/did-this-help",
        blurb: "The whole survey is yes or no.",
      },
    ],
  },
  {
    stage: "Advocacy",
    link: {
      label: "Play",
      href: "/playbook/post-win-review-ask",
    },
    entries: [
      {
        key: "advocacy/review-ask",
        blurb: "Asks at the win — and knows who clicked through.",
      },
    ],
  },
  {
    stage: "Measurement",
    link: {
      label: "Play",
      href: "/playbook/prove-the-journey-worked",
    },
    headerLink: {
      label: "Holdout play",
      href: "/playbook/program-level-holdout",
    },
    entries: [
      {
        key: "impact/journey-lift-report",
        blurb: "Lift vs holdout, as an email a stakeholder can read.",
      },
    ],
  },
  {
    stage: "Transactional",
    link: {
      label: "Transactional API",
      href: "/docs/data-api/emails",
    },
    entries: [
      {
        key: "welcome",
        blurb: "The first email, sent on signup.",
      },
      {
        key: "transactional/verify-email",
        blurb: "Verification without the drama.",
      },
      {
        key: "transactional/magic-link",
        blurb: "Passwordless sign-in link.",
      },
      {
        key: "transactional/receipt",
        blurb: "A receipt that reads like a receipt.",
      },
    ],
  },
  {
    stage: "Marketing",
    link: {
      label: "Campaigns guide",
      href: "/docs/guides/campaigns",
    },
    entries: [
      {
        key: "marketing/product-update",
        blurb: "The broadcast, gated by the preference center.",
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
  name: `${TEMPLATE_COUNT} React Email templates, in your repo`,
  description:
    "Production lifecycle templates — onboarding, billing, win-back, surveys, QR tickets, impact reports — as React Email + Tailwind components you own.",
  url: `${SITE_URL}/emails`,
  mainEntity: {
    "@type": "ItemList",
    numberOfItems: TEMPLATE_COUNT,
    itemListElement: GROUPS.flatMap((group) => group.entries).map(
      (entry, index) => ({
        "@type": "ListItem",
        position: index + 1,
        name: entry.key,
        url: sourceUrl(flatName(entry.key)),
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
  const name = flatName(entry.key);
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
              src={`/images/emails/${name}.png`}
              alt={`${entry.key} email template preview`}
              fill
              sizes="(min-width: 1024px) 347px, (min-width: 640px) 50vw, 100vw"
              className="object-cover object-top"
            />
          </div>
        </div>

        <div className="flex items-start justify-between gap-3">
          <h3 className="break-all font-mono text-[15px] text-white leading-6">
            {entry.key}
          </h3>
          <TagPill className="shrink-0">{stage}</TagPill>
        </div>

        <p className="text-base text-white/60 leading-6">{entry.blurb}</p>

        <div className="mt-auto flex items-center gap-5 pt-1 text-sm tracking-[-0.02em]">
          <a
            href={sourceUrl(name)}
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

        {/* "Email me this one" is disabled for now: a public form that mails
            any typed address is an abuse vector. Revisit behind the signed-up
            flow (terms + privacy consent) before re-enabling.
        <SampleRequest template={entry.key} /> */}
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
            {TEMPLATE_COUNT} templates, already written
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Production React Email + Tailwind components covering the whole
            lifecycle — onboarding to billing to the impact report. Every
            screenshot below is rendered from the live registry, straight from
            the source in the example app.
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
                    key={entry.key}
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
                title: "Edited where you edit everything else",
                description:
                  "Templates are React Email + Tailwind components in src/emails/ — edit them like any component. Studio previews them with live props and per-template stats, while the editing itself stays in your editor, where changes get reviewed.",
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
            The starter set, one command
          </h2>
          <p className="mt-5 max-w-xl text-base text-white/70 leading-6">
            The scaffold ships a lean starter set — plus journeys, Docker, and
            env — in a repo you own. Every template on this page lives in the
            example app; copying one into your src/emails/ is a paste.
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
            Free to self-host · One scaffold command · No per-contact billing
          </p>
        </Reveal>
      </Section>
    </main>
  );
}
