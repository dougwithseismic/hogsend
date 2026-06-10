import type { Metadata } from "next";
import Link from "next/link";
import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CopyButton } from "@/components/ds/copy-button";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

export const metadata: Metadata = {
  title: "About: built from client work",
  description:
    "Hogsend was built by Doug Silkstone after 15+ years of freelance growth engineering — the lifecycle stack he kept rebuilding for clients, shipped as a framework.",
};

const SCAFFOLD_COMMAND = "pnpm dlx create-hogsend@latest my-app";
const GITHUB_ISSUES_URL = "https://github.com/dougwithseismic/hogsend/issues";
const RAILWAY_URL = "https://railway.com/deploy/hogsend-posthog-audience-stack";

/** Why-it's-shaped-like-this pillars (links from the verified link map). */
const PILLARS = [
  {
    title: "Code-first",
    body: "Journeys are TypeScript because lifecycle logic is product logic, and product logic gets reviewed, tested, and blamed.",
    href: "/docs/concepts/philosophy",
    linkLabel: "Philosophy",
  },
  {
    title: "Studio observes, it doesn't author",
    body: "The moment a UI can edit what's in git, git stops being the truth. Studio shows you everything and changes nothing.",
    href: "/docs/operating/studio",
    linkLabel: "Studio",
  },
  {
    title: "PostHog-first, not PostHog-only",
    body: "Events in from anywhere, engagement out to anywhere. PostHog is the default center of gravity, not a cage.",
    href: "/docs/concepts/how-it-works",
    linkLabel: "How it works",
  },
] as const;

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "AboutPage",
  name: "About: built from client work",
  url: "https://hogsend.com/about",
  description:
    "Hogsend was built by Doug Silkstone after 15+ years of freelance growth engineering — the lifecycle stack he kept rebuilding for clients, shipped as a framework.",
  mainEntity: {
    "@type": "Person",
    name: "Doug Silkstone",
    jobTitle: "Software engineer",
    email: "mailto:doug@withseismic.com",
  },
};

export default function AboutPage(): JSX.Element {
  return (
    <main className="flex flex-1 flex-col">
      <script
        type="application/ld+json"
        // Static literal defined above — no user input flows in.
        // biome-ignore lint/security/noDangerouslySetInnerHtml: static JSON-LD
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      {/* ---------------------------------------------------------------- */}
      {/* Header                                                            */}
      {/* ---------------------------------------------------------------- */}
      <Section
        divider={false}
        containerClassName="container-page pt-32 pb-20 flex flex-col items-center text-center"
      >
        <Reveal className="flex flex-col items-center">
          <Eyebrow>About</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-5xl text-white leading-[1.05] tracking-[-0.04em] md:text-[64px] md:leading-[1.0]">
            Built from client work, not a pitch deck
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Hogsend exists because one engineer kept rebuilding the same thing.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The short version — founder story                                 */}
      {/* ---------------------------------------------------------------- */}
      <Section>
        <div className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-20">
          <Reveal>
            <SectionHeading
              eyebrow="The short version"
              title="One engineer, the same wall, every engagement"
            />
          </Reveal>

          <Reveal delay={0.08}>
            <div className="flex flex-col gap-5 text-base text-white/80 leading-6">
              <p>
                I'm Doug Silkstone — a software engineer with a previous life in
                growth engineering, analytics, and martech. Over 15+ years of
                freelance startup and product work, every engagement hit the
                same wall: the team had PostHog, had Resend, and had a folder of
                webhook handlers pretending to be a lifecycle email system.
                Dashboards everywhere — and then someone asks "can we send an
                email when someone drops off onboarding?" and everyone stares at
                each other.
              </p>
              <p>
                I rebuilt that system enough times to know exactly what it
                should be: durable journeys, real segments, suppression that
                actually suppresses, all as code the team can review. So I built
                it once, properly, and versioned it. Hogsend is that codebase —
                shipped as a framework you install (
                <code className="rounded-[3px] border border-white/[0.08] bg-white/[0.04] px-1.5 py-0.5 font-mono text-[13px] text-white/90">
                  @hogsend/engine
                </code>
                ), not a service you rent or a repo you fork.
              </p>
            </div>
          </Reveal>
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Why it's shaped like this — 3 pillars                             */}
      {/* ---------------------------------------------------------------- */}
      <Section>
        <Reveal>
          <SectionHeading
            eyebrow="Philosophy"
            title="Why it's shaped like this"
          />
        </Reveal>

        <div className="mt-12 grid gap-6 md:grid-cols-3">
          {PILLARS.map((pillar, i) => (
            <Reveal key={pillar.href} delay={(i % 3) * 0.08}>
              <Card className="flex h-full flex-col gap-3">
                <h3 className="font-medium text-white text-xl leading-[1.2] tracking-[-0.02em]">
                  {pillar.title}
                </h3>
                <p className="text-base text-white/60 leading-6">
                  {pillar.body}
                </p>
                <Link
                  href={pillar.href}
                  className="mt-auto inline-flex items-center gap-1.5 pt-2 font-medium text-sm text-white transition-colors hover:text-white/80"
                >
                  {pillar.linkLabel}
                  <span aria-hidden="true">→</span>
                </Link>
              </Card>
            </Reveal>
          ))}
        </div>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* How it's run — manifesto statement                                */}
      {/* ---------------------------------------------------------------- */}
      <Section>
        <Reveal className="flex flex-col items-center text-center">
          <Eyebrow className="mb-6">How it's run</Eyebrow>
          <p className="max-w-[900px] font-display text-[28px] text-white leading-[1.3] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
            One engineer, building in the open. No growth team — which is funny,
            given the product.
          </p>
          <p className="mt-8 max-w-2xl text-base text-white/60 leading-6">
            Roadmap lives in{" "}
            <a
              href={GITHUB_ISSUES_URL}
              target="_blank"
              rel="noreferrer"
              className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              GitHub issues
            </a>{" "}
            and the{" "}
            <Link
              href="/changelog"
              className="text-white/80 underline decoration-white/30 underline-offset-4 transition-colors hover:text-white"
            >
              changelog
            </Link>
            . Pre-1.0 and versioned properly: the public surface is
            semver-committed, and breaking changes are documented, not
            discovered.
          </p>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* The setup week — done-for-you installation                        */}
      {/* ---------------------------------------------------------------- */}
      <Section id="setup-week">
        <Reveal>
          <Card className="relative overflow-hidden p-8 md:p-12">
            {/* Red atmosphere bleeding in from the left edge. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(70% 120% at 0% 100%, rgba(246, 72, 56, 0.18), transparent 65%)",
              }}
            />

            <div className="relative grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center">
              <div className="flex flex-col items-start">
                <Eyebrow className="mb-4">The setup week</Eyebrow>
                <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
                  Set up for you, in a week
                </h2>
                <p className="mt-5 max-w-xl text-base text-white/70 leading-6">
                  I built Hogsend to go faster for my clients; the setup week is
                  the same engagement, productised. One week, $2,300 — deployed
                  on your infrastructure, PostHog and your provider wired in,
                  event taxonomy agreed, templates ported, and your first
                  journeys live in your repo by Friday.
                </p>
                <div className="mt-8 flex flex-wrap items-center gap-5">
                  <Button href="mailto:doug@withseismic.com" icon>
                    Email doug@withseismic.com
                  </Button>
                </div>
              </div>

              <div className="flex flex-col gap-4">
                <Card className="bg-white/[0.02]">
                  <p className="text-base text-white/80 leading-6">
                    Bugs go to{" "}
                    <a
                      href={GITHUB_ISSUES_URL}
                      target="_blank"
                      rel="noreferrer"
                      className="text-white underline decoration-white/30 underline-offset-4 transition-colors hover:text-white/80"
                    >
                      GitHub issues
                    </a>
                    . I read everything.
                  </p>
                </Card>
                <Card className="bg-white/[0.02]">
                  <p className="text-base text-white/80 leading-6">
                    No forms or calendars. Email what you're working on and
                    you'll get a straight answer — including "you don't need me
                    for this."
                  </p>
                </Card>
              </div>
            </div>
          </Card>
        </Reveal>
      </Section>

      {/* ---------------------------------------------------------------- */}
      {/* Closing CTA — standard trio                                       */}
      {/* ---------------------------------------------------------------- */}
      <Section>
        <Reveal>
          <div className="relative overflow-hidden rounded-md border border-white/10">
            {/* Red glow bleeding from the left of the CTA card. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(80% 140% at 0% 50%, rgba(246, 72, 56, 0.22), transparent 60%)",
              }}
            />

            <div className="relative grid gap-10 p-8 md:p-14 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center">
              <div className="flex flex-col items-start">
                <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
                  Your events are already flowing. Put them to work.
                </h2>
                <p className="mt-5 max-w-lg text-base text-white/70 leading-6">
                  One scaffold command gives you the engine, 10 journeys, and 13
                  templates — in your repo, under your review.
                </p>

                <div className="mt-8 flex flex-wrap items-center gap-5">
                  <Button href="/docs/getting-started" icon>
                    Start building
                  </Button>
                  <Button href={RAILWAY_URL} variant="outline" external>
                    Deploy on Railway
                  </Button>
                  <Link
                    href="/docs"
                    className="text-base text-white/70 transition-colors hover:text-white"
                  >
                    or read the docs first →
                  </Link>
                </div>

                <p className="mt-6 font-mono text-[11px] text-white/40 uppercase tracking-[0.08em]">
                  Free to self-host · One scaffold command · No per-contact
                  billing
                </p>
              </div>

              <div className="overflow-hidden rounded-[10px] border border-white/10 bg-[#0a0606]">
                <div className="flex items-center justify-between border-white/[0.08] border-b px-4 py-2.5">
                  <span className="font-mono text-[11px] text-white/40 tracking-wide">
                    Terminal
                  </span>
                  <CopyButton value={SCAFFOLD_COMMAND} />
                </div>
                <pre className="overflow-x-auto px-4 py-5 font-mono text-[13px] leading-relaxed">
                  <code>
                    <span className="text-white/40">$ </span>
                    <span className="text-white/90">{SCAFFOLD_COMMAND}</span>
                  </code>
                </pre>
              </div>
            </div>
          </div>
        </Reveal>
      </Section>
    </main>
  );
}
