import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Reveal } from "@/components/ds/reveal";
import { EmailCapture } from "@/components/landing/email-capture";
import { cn } from "@/lib/cn";

/**
 * LiveDemo — the section directly under the hero: the product demonstrating
 * itself. The form feeds a stock create-hogsend app running in production;
 * subscribing fires the docs.subscribed event, the welcome journey runs, and
 * the email arrives from hello@hogsend.com. The crimzon card fills the whole
 * 1200px frame box edge-to-edge (no card-within-a-box inset), with the subtle
 * accent aura, copy centred, the shared EmailCapture inside.
 */
export function LiveDemo({ className }: { className?: string }): JSX.Element {
  return (
    <section
      id="live-demo"
      className={cn(
        "relative overflow-hidden border-hairline-faint border-t text-white",
        className,
      )}
    >
      <div className="relative mx-auto w-full max-w-[75rem] overflow-hidden bg-[#070303] px-6 py-16 md:px-12 md:py-24">
        {/* Subtle red aura rising from the bottom edge of the card. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(60% 80% at 50% 100%, rgba(246,72,56,0.14), rgba(246,72,56,0.04) 50%, transparent 75%)",
          }}
        />

        <Reveal>
          <div className="relative mx-auto flex max-w-2xl flex-col items-center text-center">
            <Eyebrow className="mb-4">Live demo</Eyebrow>

            <h2 className="font-display text-[32px] text-white leading-[1.2] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
              The product, running on itself
            </h2>

            <p className="mt-5 max-w-xl text-base text-white/60 leading-6">
              This form feeds a stock create-hogsend app running in production.
              It ingests the event, runs its welcome journey, and the email
              arrives from hello@hogsend.com a few seconds later. A nudge
              follows two days on.
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
        </Reveal>
      </div>
    </section>
  );
}
