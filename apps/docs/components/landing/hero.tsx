import type { JSX } from "react";
import { PillBadge } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { GlowField } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

type HeroProps = {
  className?: string;
};

/**
 * Crimzon hero: the red planet-horizon backdrop, a pill badge carrying the
 * license line, a two-line 80px Inter Display H1, a two-line subhead, then
 * the primary white CTA + a plain-text secondary link, with friction
 * microcopy beneath. No terminal here — the scaffold command lives in
 * HowItWorks and the closing CTA.
 */
export function Hero({ className }: HeroProps): JSX.Element {
  return (
    <section
      className={cn("relative overflow-hidden bg-ink text-white", className)}
    >
      {/* Red planet-horizon backdrop behind all content. */}
      <GlowField />

      <div className="container-page relative z-10 flex flex-col items-center pt-40 pb-36 text-center md:pt-[188px] md:pb-44">
        <Reveal className="flex flex-col items-center">
          <PillBadge>Self-hosted · your repo, your provider</PillBadge>

          <h1 className="mt-8 max-w-6xl font-display font-medium text-5xl text-white leading-[1.02] tracking-[-0.06em] md:text-[72px] md:leading-[74px]">
            Lifecycle email is a feature.
            <br />
            Ship it like one.
          </h1>

          <p className="mt-7 max-w-[520px] text-base text-white/80 leading-6">
            Welcome series, trial nudges, win-backs, payment saves — every
            product needs them, and they never make the sprint. Hogsend turns
            PostHog and product events into journeys that live in your repo and
            send through your own Resend or Postmark account.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-5">
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Button href="/docs/getting-started" variant="accent" icon>
              Start building
            </Button>
            <Button href="/docs" variant="outline">
              Read the docs
            </Button>
          </div>

          <p className="text-sm text-white/50">
            Free to self-host · one scaffold command · 3 env vars on Railway
          </p>
        </Reveal>
      </div>
    </section>
  );
}
