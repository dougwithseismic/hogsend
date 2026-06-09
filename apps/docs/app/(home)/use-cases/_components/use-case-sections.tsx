import { ArrowUpRight } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeHighlight } from "@/components/ds/code-highlight";
import { CopyButton } from "@/components/ds/copy-button";
import { FaqAccordion } from "@/components/ds/faq";
import { AuroraBeam } from "@/components/ds/fx";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

/* ------------------------------------------------------------------------ */
/* Shared data                                                               */
/* ------------------------------------------------------------------------ */

const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

export type UseCaseId = "onboarding" | "trial-conversion" | "winback";

const USE_CASES: Record<
  UseCaseId,
  { title: string; description: string; href: string }
> = {
  onboarding: {
    title: "Onboarding",
    description: "Onboarding that waits for behavior, not the calendar.",
    href: "/use-cases/onboarding",
  },
  "trial-conversion": {
    title: "Trial conversion",
    description: "Trial emails driven by usage, not days remaining.",
    href: "/use-cases/trial-conversion",
  },
  winback: {
    title: "Win-back",
    description: "Win-back that knows when someone actually left.",
    href: "/use-cases/winback",
  },
};

/* ------------------------------------------------------------------------ */
/* Small shared pieces                                                       */
/* ------------------------------------------------------------------------ */

function FrictionMicrocopy({ className }: { className?: string }): JSX.Element {
  return (
    <p
      className={`font-mono text-[11px] text-white/50 uppercase tracking-[0.08em] ${className ?? ""}`}
    >
      Free to self-host · One scaffold command · 3 env vars on Railway
    </p>
  );
}

/* ------------------------------------------------------------------------ */
/* Hero                                                                      */
/* ------------------------------------------------------------------------ */

type UseCaseHeroProps = {
  eyebrow: string;
  title: ReactNode;
  subhead: string;
};

export function UseCaseHero({
  eyebrow,
  title,
  subhead,
}: UseCaseHeroProps): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>{eyebrow}</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            {title}
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            {subhead}
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href="/docs/getting-started" icon>
              Start building
            </Button>
            <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
              Deploy on Railway
            </Button>
          </div>
          <FrictionMicrocopy />
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Problem narrative — centered manifesto-style statement                    */
/* ------------------------------------------------------------------------ */

type ProblemStatementProps = {
  label: string;
  children: ReactNode;
};

export function ProblemStatement({
  label,
  children,
}: ProblemStatementProps): JSX.Element {
  return (
    <Section>
      <Reveal className="flex flex-col items-center text-center">
        <Eyebrow className="mb-8">{label}</Eyebrow>
        <p className="mx-auto max-w-[900px] font-display text-[24px] text-white/90 leading-[34px] tracking-[-0.02em] md:text-[34px] md:leading-[46px]">
          {children}
        </p>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Code walkthrough — glass panels over a red atmosphere                     */
/* ------------------------------------------------------------------------ */

type CodeBlock = {
  filename: string;
  code: string;
  caption: string;
};

type CodeWalkthroughProps = {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  blocks: CodeBlock[];
  /** Optional prose note rendered after the last block. */
  note?: ReactNode;
};

function CodeWindow({
  filename,
  code,
}: {
  filename: string;
  code: string;
}): JSX.Element {
  return (
    <div className="relative">
      {/* Red atmospheric bloom behind the glass panel. */}
      <div
        aria-hidden="true"
        className="-inset-x-10 -inset-y-6 pointer-events-none absolute"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 65%, rgba(246, 72, 56, 0.14), transparent 70%)",
          filter: "blur(40px)",
        }}
      />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#0a0606]">
        <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          <span className="font-mono text-[11px] text-white/40 tracking-wide">
            {filename}
          </span>
        </div>
        <div className="px-4 py-4">
          <CodeHighlight code={code} lang="ts" />
        </div>
      </div>
    </div>
  );
}

export function CodeWalkthrough({
  eyebrow,
  title,
  subtitle,
  blocks,
  note,
}: CodeWalkthroughProps): JSX.Element {
  return (
    <Section>
      <SectionHeading eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="mt-12 flex flex-col gap-12">
        {blocks.map((block, index) => (
          <Reveal key={block.filename} delay={(index % 2) * 0.08}>
            <CodeWindow filename={block.filename} code={block.code} />
            <p className="mt-4 max-w-2xl text-sm text-white/50 leading-6">
              {block.caption}
            </p>
          </Reveal>
        ))}
      </div>
      {note ? (
        <Reveal delay={0.08}>
          <p className="mt-10 max-w-2xl text-base text-white/70 leading-6">
            {note}
          </p>
        </Reveal>
      ) : null}
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* "Why it holds up" point cards                                             */
/* ------------------------------------------------------------------------ */

type Point = {
  title: ReactNode;
  body: ReactNode;
};

type PointsGridProps = {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  points: Point[];
};

export function PointsGrid({
  eyebrow,
  title,
  subtitle,
  points,
}: PointsGridProps): JSX.Element {
  return (
    <Section>
      <SectionHeading eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {points.map((point, index) => (
          <Reveal
            // biome-ignore lint/suspicious/noArrayIndexKey: static, never reordered
            key={index}
            delay={(index % 2) * 0.08}
          >
            <Card className="h-full">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                {point.title}
              </h3>
              <p className="mt-3 text-base text-white/60 leading-6">
                {point.body}
              </p>
            </Card>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Templates strip                                                           */
/* ------------------------------------------------------------------------ */

type TemplateThumb = {
  /** Template key — must match a PNG in public/images/emails/. */
  slug: string;
  name: string;
};

type TemplatesStripProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  templates: TemplateThumb[];
};

export function TemplatesStrip({
  title,
  subtitle,
  templates,
}: TemplatesStripProps): JSX.Element {
  const cols =
    templates.length === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3";

  return (
    <Section>
      <SectionHeading eyebrow="Templates" title={title} subtitle={subtitle} />
      <div className={`mt-12 grid grid-cols-1 gap-6 ${cols}`}>
        {templates.map((template, index) => (
          <Reveal key={template.slug} delay={(index % 4) * 0.08}>
            <Link href="/emails" className="group block">
              <div className="overflow-hidden rounded-md border border-white/[0.08] bg-white/[0.02] transition-colors duration-200 group-hover:border-white/15">
                <div className="relative aspect-[4/3] overflow-hidden border-white/[0.08] border-b">
                  <Image
                    src={`/images/emails/${template.slug}.png`}
                    alt={`${template.name} email template preview`}
                    fill
                    sizes="(min-width: 1024px) 280px, (min-width: 640px) 45vw, 90vw"
                    className="object-cover object-top"
                  />
                </div>
                <p className="px-4 py-3 text-sm text-white/50">
                  {template.name}
                </p>
              </div>
            </Link>
          </Reveal>
        ))}
      </div>
      <Reveal delay={0.16}>
        <div className="mt-10">
          <Button href="/emails" variant="outline" icon>
            See all 13 templates
          </Button>
        </div>
      </Reveal>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* FAQ (2-col: heading + deep links left, accordion right)                   */
/* ------------------------------------------------------------------------ */

export type FaqItem = { q: string; a: string };

type DeepLink = { label: string; href: string };

type UseCaseFaqProps = {
  items: FaqItem[];
  links: DeepLink[];
};

export function UseCaseFaq({ items, links }: UseCaseFaqProps): JSX.Element {
  return (
    <Section>
      <div className="grid grid-cols-1 gap-12 lg:grid-cols-2 lg:gap-16">
        <div className="lg:sticky lg:top-28 lg:self-start">
          <Reveal>
            <SectionHeading
              eyebrow="FAQ"
              title="Questions, answered"
              subtitle="The short versions. The docs have the long ones."
            />
            <p className="mt-10 font-medium text-base text-white tracking-[-0.02em]">
              Go deeper
            </p>
            <ul className="mt-4 flex flex-col gap-3">
              {links.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="group inline-flex items-center gap-1.5 text-base text-white/60 transition-colors hover:text-white"
                  >
                    {link.label}
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                      strokeWidth={1.5}
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </Reveal>
        </div>
        <Reveal delay={0.08}>
          <FaqAccordion items={items} />
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* More use cases — cross-links to the two siblings                          */
/* ------------------------------------------------------------------------ */

export function MoreUseCases({ current }: { current: UseCaseId }): JSX.Element {
  const siblings = (Object.keys(USE_CASES) as UseCaseId[]).filter(
    (id) => id !== current,
  );

  return (
    <Section>
      <SectionHeading
        eyebrow="More use cases"
        title="Same engine, different lifecycle stage"
      />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2">
        {siblings.map((id, index) => {
          const useCase = USE_CASES[id];
          return (
            <Reveal key={id} delay={(index % 2) * 0.08}>
              <Link href={useCase.href} className="group block h-full">
                <Card className="flex h-full flex-col gap-3">
                  <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                    {useCase.title}
                  </h3>
                  <p className="text-base text-white/60 leading-6">
                    {useCase.description}
                  </p>
                  <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm text-white/60 transition-colors group-hover:text-white">
                    Read the use case
                    <ArrowUpRight
                      aria-hidden="true"
                      className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                      strokeWidth={1.5}
                    />
                  </span>
                </Card>
              </Link>
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Closing CTA — big bordered card, red glow from the left, terminal right   */
/* ------------------------------------------------------------------------ */

type ClosingCtaProps = {
  title: ReactNode;
  subtitle: string;
};

export function ClosingCta({ title, subtitle }: ClosingCtaProps): JSX.Element {
  return (
    <Section>
      <Reveal>
        <div className="relative overflow-hidden rounded-md border border-white/10">
          {/* Red glow bleeding in from the left edge. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 110% at 0% 60%, rgba(246, 72, 56, 0.22), transparent 60%)",
            }}
          />
          <div className="relative z-10 grid grid-cols-1 items-center gap-12 p-8 md:p-14 lg:grid-cols-2">
            <div>
              <h2 className="max-w-xl font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
                {title}
              </h2>
              <p className="mt-5 max-w-md text-base text-white/70 leading-6">
                {subtitle}
              </p>
              <div className="mt-8 flex flex-wrap items-center gap-4">
                <Button href="/docs/getting-started" icon>
                  Start building
                </Button>
                <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
                  Deploy on Railway
                </Button>
                <Link
                  href="/docs"
                  className="text-base text-white/60 transition-colors hover:text-white"
                >
                  or read the docs first →
                </Link>
              </div>
              <FrictionMicrocopy className="mt-6" />
            </div>
            <div className="relative">
              <CodeMock
                lines={[{ text: INSTALL_COMMAND, tone: "accent" }]}
                filename="terminal"
              />
              <CopyButton
                value={INSTALL_COMMAND}
                className="absolute top-2.5 right-3"
              />
            </div>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
