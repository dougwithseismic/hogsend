import type { JSX, ReactNode } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

/* ------------------------------------------------------------------------ */
/* Hero                                                                      */
/* ------------------------------------------------------------------------ */

export function CampaignsHero(): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Campaigns</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            One-off sends to your whole audience
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            A campaign sends one template to every subscribed member of a list —
            or every active member of a bucket — at an instant you pick. Commit
            it as a file or queue it with one API call. Scheduled, cancelable
            until send, deduplicated per recipient.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href="/docs/guides/campaigns" icon>
              Read the guide
            </Button>
            <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
              Deploy on Railway
            </Button>
          </div>
          <p className="font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
            One file · Ships on deploy · Cancel until it sends
          </p>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* Prose section — eyebrow + heading + one body paragraph                    */
/* ------------------------------------------------------------------------ */

type ProseSectionProps = {
  eyebrow: string;
  title: ReactNode;
  children: ReactNode;
};

export function ProseSection({
  eyebrow,
  title,
  children,
}: ProseSectionProps): JSX.Element {
  return (
    <Section>
      <SectionHeading eyebrow={eyebrow} title={title} />
      <Reveal delay={0.08}>
        <p className="mt-6 max-w-3xl text-base text-white/70 leading-7">
          {children}
        </p>
      </Reveal>
    </Section>
  );
}
