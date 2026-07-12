import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { AuroraBeam } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

/* ------------------------------------------------------------------------ */
/* Hero                                                                      */
/* ------------------------------------------------------------------------ */

export function PaidHero(): JSX.Element {
  return (
    <Section divider={false} containerClassName="container-page pt-32 pb-20">
      <AuroraBeam />
      <div className="relative z-10 flex flex-col items-center text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow>Paid acquisition</Eyebrow>
          <h1 className="mt-6 max-w-4xl font-display font-medium text-[40px] text-white leading-[1.05] tracking-[-0.05em] md:text-[64px] md:leading-[1.0]">
            Make your paid budget go further
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/80 leading-6">
            Every ad click, form fill, quote and closed deal lands on one
            contact timeline — and the sale goes back to Meta server-side, with
            its value and the original click attached. Your campaigns optimize
            toward buyers, not clickers.
          </p>
        </Reveal>
        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-4">
            <Button href="/docs/guides/revenue" icon>
              Read the revenue docs
            </Button>
            <Button href={RAILWAY_DEPLOY_URL} variant="outline" external>
              Deploy on Railway
            </Button>
          </div>
          <p className="font-mono text-[11px] text-white/50 uppercase tracking-[0.08em]">
            First-party click capture · Real values · Counted exactly once
          </p>
        </Reveal>
      </div>
    </Section>
  );
}

/* ------------------------------------------------------------------------ */
/* The loop — five hops, click to CAPI, as a mono flow panel                 */
/* ------------------------------------------------------------------------ */

const LOOP_STEPS: Array<{ step: string; detail: string }> = [
  {
    step: "Ad click",
    detail:
      "@hogsend/js fires campaign.arrived — fbclid, UTMs, the real timestamp",
  },
  {
    step: "Lead",
    detail:
      "any form vendor's webhook → lead.submitted, stitched to the browser session",
  },
  {
    step: "Deal",
    detail:
      "CRM stages map to canonical ones; quoted and sold mint valued events",
  },
  {
    step: "Conversion",
    detail:
      "defineConversion matches the event — recorded once, value resolved",
  },
  {
    step: "Feedback",
    detail:
      "delivered to Meta CAPI with the original click and a dedup id, retried until received",
  },
];

export function LoopPanel(): JSX.Element {
  return (
    <Section>
      <SectionHeading
        eyebrow="The loop"
        title="Click in, sale out, nothing invisible in between"
        subtitle="Each hop is an event on the same contact. The value that comes out the bottom is attributable to the click that went in the top."
      />
      <Reveal delay={0.08}>
        <div className="relative mt-12 overflow-hidden rounded-xl border border-white/10 bg-[#0a0606]">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(70% 110% at 0% 0%, rgba(246, 72, 56, 0.10), transparent 60%)",
            }}
          />
          <ol className="relative z-10 flex flex-col">
            {LOOP_STEPS.map((item, index) => (
              <li
                key={item.step}
                className="flex flex-col gap-1 border-white/[0.08] border-b px-6 py-5 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6"
              >
                <span className="flex shrink-0 items-baseline gap-3 sm:w-40">
                  <span className="font-mono text-[11px] text-white/40">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="font-medium text-base text-white tracking-[-0.02em]">
                    {item.step}
                  </span>
                </span>
                <span className="font-mono text-[13px] text-white/60 leading-6">
                  {item.detail}
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Reveal>
    </Section>
  );
}
