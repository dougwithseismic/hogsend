import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { Section } from "@/components/ds/section";
import { EmailCapture } from "@/components/landing/email-capture";

/**
 * LiveDemo — the section directly under the hero: the product demonstrating
 * itself. The form feeds a stock create-hogsend app running in production;
 * subscribing fires the docs.subscribed event, the welcome journey runs, and
 * the email arrives from hello@hogsend.com. One bordered crimzon card with a
 * subtle accent aura, copy centred, the shared EmailCapture inside.
 */
export function LiveDemo({ className }: { className?: string }): JSX.Element {
  return (
    <Section id="live-demo" className={className}>
      <Reveal>
        <div className="relative overflow-hidden rounded-md border border-white/10 bg-[#070303] px-6 py-12 md:px-12 md:py-16">
          {/* Subtle red aura rising from the bottom edge of the card. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(60% 80% at 50% 100%, rgba(246,72,56,0.14), rgba(246,72,56,0.04) 50%, transparent 75%)",
            }}
          />

          <div className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
            <Eyebrow className="mb-4">Live demo</Eyebrow>

            <h2 className="font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              Put an email in.
              <br />
              The product does the rest.
            </h2>

            <p className="mt-5 max-w-xl text-base text-white/60 leading-6">
              This form feeds a stock create-hogsend app running in production.
              It ingests the event, runs its welcome journey, and the email
              arrives from hello@hogsend.com a few seconds later. A nudge
              follows in two days unless you deploy first.
            </p>

            <EmailCapture
              hideHeading
              placement="hero"
              className="mt-8 w-full max-w-md"
            />

            <p className="mt-5 text-sm text-white/50">
              Same engine, same journey code you scaffold · unsubscribe is one
              click
            </p>
          </div>
        </div>
      </Reveal>
    </Section>
  );
}
