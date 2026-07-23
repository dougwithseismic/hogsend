import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import type { JSX, ReactNode } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { Card } from "@/components/ds/card";
import { CodeWindow } from "@/components/ds/code-window";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";

/* ------------------------------------------------------------------------ */
/* Re-exports — the shared sections feature pages compose alongside these    */
/* ------------------------------------------------------------------------ */

export {
  ClosingCta,
  CodeWalkthrough,
  type FaqItem,
  PointsGrid,
  UseCaseFaq,
} from "@/app/(home)/use-cases/_components/use-case-sections";
export { Stat } from "@/components/ds/decor";

/* ------------------------------------------------------------------------ */
/* Hero                                                                      */
/* ------------------------------------------------------------------------ */

type Cta = {
  label: string;
  href: string;
  external?: boolean;
};

type FeatureHeroProps = {
  eyebrow: string;
  title: ReactNode;
  subhead: ReactNode;
  primaryCta?: Cta;
  secondaryCta?: Cta;
  /** Mono friction line under the buttons, e.g. "One file · Ships on deploy". */
  microcopy?: string;
};

/**
 * Feature-page hero: aurora backdrop, kicker, display H1, subhead, a primary/
 * secondary button pair, and a mono microcopy line — the CampaignsHero recipe,
 * parameterized.
 */
export function FeatureHero({
  eyebrow,
  title,
  subhead,
  primaryCta,
  secondaryCta,
  microcopy,
}: FeatureHeroProps): JSX.Element {
  const hasCtas = Boolean(primaryCta || secondaryCta);

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
        {hasCtas || microcopy ? (
          <Reveal
            delay={0.1}
            className="mt-12 flex flex-col items-center gap-5"
          >
            {hasCtas ? (
              <div className="flex flex-wrap items-center justify-center gap-4">
                {primaryCta ? (
                  <Button
                    href={primaryCta.href}
                    external={primaryCta.external}
                    icon
                  >
                    {primaryCta.label}
                  </Button>
                ) : null}
                {secondaryCta ? (
                  <Button
                    href={secondaryCta.href}
                    external={secondaryCta.external}
                    variant="outline"
                  >
                    {secondaryCta.label}
                  </Button>
                ) : null}
              </div>
            ) : null}
            {microcopy ? (
              <p className="font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
                {microcopy}
              </p>
            ) : null}
          </Reveal>
        ) : null}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Capability band — copy one side, code (or media) the other                */
/* ------------------------------------------------------------------------ */

type CapabilityBandProps = {
  eyebrow?: string;
  title: ReactNode;
  /** Body copy — paragraphs; rendered white/70 next to the visual. */
  children: ReactNode;
  code?: { filename: string; code: string; lang?: string };
  /** Arbitrary visual node used when there's no code sample. */
  media?: ReactNode;
  /** Put the visual on the left (desktop) — alternate bands with this. */
  flip?: boolean;
};

/**
 * Two-column capability band: left-aligned section heading + body copy on one
 * side, a CodeWindow (or any media node) on the other. `flip` swaps the sides
 * on desktop so consecutive bands alternate.
 */
export function CapabilityBand({
  eyebrow,
  title,
  children,
  code,
  media,
  flip = false,
}: CapabilityBandProps): JSX.Element {
  const visual = code ? (
    <CodeWindow filename={code.filename} code={code.code} lang={code.lang} />
  ) : (
    (media ?? null)
  );

  return (
    <Section>
      <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-16">
        <Reveal className={flip ? "lg:order-last" : undefined}>
          <SectionHeading eyebrow={eyebrow} title={title} align="left" />
          <div className="mt-6 flex max-w-xl flex-col gap-4 text-base text-white/70 leading-7">
            {children}
          </div>
        </Reveal>
        {visual ? (
          <Reveal delay={0.08} className={flip ? "lg:order-first" : undefined}>
            {visual}
          </Reveal>
        ) : null}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Feature grid — one card per capability                                    */
/* ------------------------------------------------------------------------ */

type FeatureGridItem = {
  title: string;
  body: ReactNode;
  href?: string;
};

type FeatureGridProps = {
  eyebrow: string;
  title: ReactNode;
  subtitle?: ReactNode;
  items: FeatureGridItem[];
};

/**
 * Responsive 3-column grid of capability cards. Items with an `href` render
 * as links with the site's card hover treatment.
 */
export function FeatureGrid({
  eyebrow,
  title,
  subtitle,
  items,
}: FeatureGridProps): JSX.Element {
  return (
    <Section>
      <SectionHeading eyebrow={eyebrow} title={title} subtitle={subtitle} />
      <div className="mt-12 grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item, index) => {
          const card = (
            <Card className="flex h-full flex-col gap-2.5">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                {item.title}
              </h3>
              <p className="text-base text-white/60 leading-6">{item.body}</p>
            </Card>
          );

          return (
            <Reveal key={item.title} delay={(index % 3) * 0.08}>
              {item.href ? (
                <Link href={item.href} className="group block h-full">
                  {card}
                </Link>
              ) : (
                card
              )}
            </Reveal>
          );
        })}
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Cross-links — related-pages band                                          */
/* ------------------------------------------------------------------------ */

type CrossLinkItem = {
  label: string;
  description: string;
  href: string;
};

type CrossLinksProps = {
  items: CrossLinkItem[];
};

/**
 * Related-pages band: a row of link cards pointing at sibling marketing
 * pages, each with the site's hover treatment and a trailing arrow.
 */
export function CrossLinks({ items }: CrossLinksProps): JSX.Element {
  const cols =
    items.length === 4 ? "sm:grid-cols-2 lg:grid-cols-4" : "sm:grid-cols-3";

  return (
    <Section>
      <SectionHeading eyebrow="Related" title="More from Hogsend" />
      <div className={`mt-12 grid grid-cols-1 gap-6 ${cols}`}>
        {items.map((item, index) => (
          <Reveal key={item.href} delay={(index % 4) * 0.08}>
            <Link href={item.href} className="group block h-full">
              <Card className="flex h-full flex-col gap-3">
                <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                  {item.label}
                </h3>
                <p className="text-base text-white/60 leading-6">
                  {item.description}
                </p>
                <span className="mt-auto inline-flex items-center gap-1.5 pt-2 text-sm text-white/60 transition-colors group-hover:text-white">
                  Visit
                  <ArrowUpRight
                    aria-hidden="true"
                    className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
                    strokeWidth={1.5}
                  />
                </span>
              </Card>
            </Link>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
