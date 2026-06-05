import Image, { type StaticImageData } from "next/image";
import { Sunburst } from "@/components/ds/doodle";
import { MockupFrame } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import studioJourneys from "@/public/images/studio/studio-journeys.png";
import studioOverview from "@/public/images/studio/studio-overview.png";
import studioSends from "@/public/images/studio/studio-sends.png";
import studioTemplates from "@/public/images/studio/studio-templates.png";

/**
 * STUDIO (chocolate panel). A clean dashboard showcase on a rounded chocolate
 * panel stacked on the vanilla canvas: a 2x2 grid of product screenshots, each
 * framed in a dark `MockupFrame` bezel with a small Geist-Mono caption label
 * below the image, prefixed by a tiny raspberry square. Server component —
 * composes the client `Reveal` and renders static Next images with blur.
 */

const SHOTS: Array<{ img: StaticImageData; label: string }> = [
  { img: studioOverview, label: "Overview" },
  { img: studioJourneys, label: "Journeys" },
  { img: studioSends, label: "Sends" },
  { img: studioTemplates, label: "Templates" },
];

export function Studio({ className }: { className?: string }) {
  return (
    <Section tone="dark" id="studio" className={className}>
      <Reveal>
        <SectionHeading
          tone="dark"
          eyebrow="STUDIO"
          title={
            <span className="relative inline-block">
              See everything that goes out
              <Sunburst className="-top-5 -right-7 absolute size-7 text-glow" />
            </span>
          }
          subtitle="A clean dashboard for every email, journey, and contact. Watch what's happening, preview a template, resend a failed message, or pause a sequence — no digging through logs."
        />
      </Reveal>

      <div className="mt-12 grid gap-5 md:mt-16 md:grid-cols-2 md:gap-6">
        {SHOTS.map((shot, i) => (
          <Reveal key={shot.label} delay={i * 0.06}>
            <figure>
              <MockupFrame>
                {/* Cancel MockupFrame's inner padding so the screenshot bleeds
                    edge-to-edge inside the dark bezel. */}
                <Image
                  src={shot.img}
                  alt={`Hogsend Studio — ${shot.label}`}
                  className="-m-5 h-auto w-[calc(100%+2.5rem)] max-w-none rounded-[6px] md:-m-6 md:w-[calc(100%+3rem)]"
                  sizes="(max-width: 768px) 100vw, 50vw"
                  placeholder="blur"
                />
              </MockupFrame>
              <figcaption className="mt-3 flex items-center gap-2 font-mono text-[11px] text-lumen/50 uppercase tracking-wide">
                <span
                  aria-hidden="true"
                  className="size-[6px] rounded-[2px] bg-glow"
                />
                {shot.label}
              </figcaption>
            </figure>
          </Reveal>
        ))}
      </div>
    </Section>
  );
}
