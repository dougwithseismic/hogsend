import Image, { type StaticImageData } from "next/image";
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
  /** Optional Studio screenshot, framed with window chrome below the prose. */
  image?: { src: StaticImageData; alt: string; label: string };
};

export function ProseSection({
  eyebrow,
  title,
  children,
  image,
}: ProseSectionProps): JSX.Element {
  return (
    <Section>
      <SectionHeading eyebrow={eyebrow} title={title} />
      <Reveal delay={0.08}>
        <p className="mt-6 max-w-3xl text-base text-white/70 leading-7">
          {children}
        </p>
      </Reveal>
      {image ? (
        <Reveal delay={0.14}>
          <div className="relative mt-10">
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
                  {image.label}
                </span>
              </div>
              <Image src={image.src} alt={image.alt} className="w-full" />
            </div>
          </div>
        </Reveal>
      ) : null}
    </Section>
  );
}
