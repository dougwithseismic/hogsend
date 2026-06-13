import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { TrackDeployClick } from "@/components/analytics/track";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { ENGINE_VERSION } from "@/lib/site";

/**
 * ProofGrid — the crimzon testimonial-grid styling, filled with what exists:
 * npm packages, the GitHub repo, the Railway template, the setup service,
 * the works-with stack, and a founder note (real, attributed). NO invented
 * quotes, logos, stars, or user counts — ever. The register is matter-of-fact,
 * not defensive: state things, don't argue for them.
 */

type ProofCard = {
  title: string;
  body: string;
  linkLabel: string;
  href: string;
  external?: boolean;
};

const PROOF_CARDS: ProofCard[] = [
  {
    title: "11 packages on npm",
    body: `The engine, CLI, Studio, providers, and client SDK — all published at v${ENGINE_VERSION}, semver-versioned. Upgrading is one pnpm up.`,
    linkLabel: "@hogsend/engine on npm",
    href: "https://www.npmjs.com/package/@hogsend/engine",
    external: true,
  },
  {
    title: "All the code is on GitHub",
    body: "Read the source before you run it. Roadmap lives in issues, releases in the changelog — built in the open by one engineer.",
    linkLabel: "github.com/dougwithseismic/hogsend",
    href: "https://github.com/dougwithseismic/hogsend",
    external: true,
  },
  {
    title: "One-click Railway template",
    body: "Postgres, Redis, Hatchet-Lite, API, and worker — provisioned in your Railway account, ready to send.",
    linkLabel: "Deploy on Railway",
    href: "https://railway.com/deploy/hogsend-posthog-audience-stack",
    external: true,
  },
  {
    title: "Set up for you, in a week",
    body: "Prefer it done for you? One week, $2,300 — deployed on your infrastructure, wired to PostHog and your provider, first journeys live.",
    linkLabel: "How the setup week works",
    href: "/about#setup-week",
  },
];

const STACK: readonly BrandKey[] = [
  "posthog",
  "resend",
  "stripe",
  "railway",
  "segment",
  "slack",
];

export function ProofGrid({ className }: { className?: string }) {
  return (
    <Section id="proof" className={className}>
      <Reveal>
        <SectionHeading
          eyebrow="In the open"
          title="See for yourself"
          subtitle="The engine on npm, the source on GitHub, a one-click deploy, and the engineer who built it — all a click away."
        />
      </Reveal>

      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 md:mt-16 lg:grid-cols-3">
        {PROOF_CARDS.map((card, index) => {
          const inner = (
            <>
              <span className="font-medium font-sans text-base text-white tracking-[-0.02em]">
                {card.title}
              </span>
              <span className="mt-3 block text-base text-white/70 leading-[26px]">
                {card.body}
              </span>
              <span className="mt-auto flex items-center gap-1.5 pt-5 text-sm text-white/50 transition-colors group-hover:text-white">
                {card.linkLabel}
                <ArrowUpRight
                  aria-hidden="true"
                  className="size-3.5"
                  strokeWidth={1.5}
                />
              </span>
            </>
          );

          const cardClass =
            "group flex h-full flex-col rounded-md border border-white/[0.08] bg-white/[0.02] p-6 transition-colors duration-200 hover:border-white/15";

          return (
            <Reveal
              key={card.title}
              delay={(index % 3) * 0.08}
              className="h-full"
            >
              {card.external ? (
                card.href.includes("railway.com/deploy") ? (
                  <TrackDeployClick placement="proof-grid">
                    <a
                      href={card.href}
                      target="_blank"
                      rel="noreferrer"
                      className={cardClass}
                    >
                      {inner}
                    </a>
                  </TrackDeployClick>
                ) : (
                  <a
                    href={card.href}
                    target="_blank"
                    rel="noreferrer"
                    className={cardClass}
                  >
                    {inner}
                  </a>
                )
              ) : (
                <Link href={card.href} className={cardClass}>
                  {inner}
                </Link>
              )}
            </Reveal>
          );
        })}

        {/* Founder note — real, attributed. Quote-card anatomy. */}
        <Reveal delay={0.08} className="h-full">
          <div className="flex h-full flex-col rounded-md border border-white/[0.08] bg-white/[0.02] p-6 transition-colors duration-200 hover:border-white/15">
            <p className="text-base text-white/90 leading-[26px]">
              "Over 15+ years of client work, every engagement hit the same
              wall: PostHog, Resend, and a folder of webhook handlers pretending
              to be a lifecycle email system. I rebuilt it enough times to know
              exactly what it should be — so I built it once, properly, and
              versioned it."
            </p>
            <div className="mt-auto flex items-center gap-3 pt-6">
              <span
                aria-hidden="true"
                className="grid size-10 shrink-0 place-items-center rounded-full border border-white/15 bg-white/[0.04] font-medium text-sm text-white"
              >
                DS
              </span>
              <span className="flex flex-col">
                <span className="text-base text-white">Doug Silkstone</span>
                <Link
                  href="/about"
                  className="text-sm text-white/50 transition-colors hover:text-white"
                >
                  Founder — read the story →
                </Link>
              </span>
            </div>
          </div>
        </Reveal>

        {/* Works-with row — stack marks, never customers or partners. */}
        <Reveal delay={0.16} className="h-full">
          <div className="flex h-full flex-col rounded-md border border-white/[0.08] bg-white/[0.02] p-6 transition-colors duration-200 hover:border-white/15">
            <span className="font-medium font-sans text-base text-white tracking-[-0.02em]">
              Works with your stack
            </span>
            <span className="mt-3 block text-base text-white/70 leading-[26px]">
              Events in from PostHog, Stripe, Clerk, Supabase, or Segment; sends
              through Resend or Postmark; engagement back out to your tools.
            </span>
            <div className="mt-auto flex flex-wrap items-center gap-x-6 gap-y-4 pt-6 text-white/60">
              {STACK.map((brand) => (
                <BrandLogo key={brand} brand={brand} height={20} />
              ))}
            </div>
          </div>
        </Reveal>
      </div>
    </Section>
  );
}
