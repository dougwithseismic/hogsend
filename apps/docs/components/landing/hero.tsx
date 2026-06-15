import type { JSX } from "react";
import { PillBadge } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CopyButton } from "@/components/ds/copy-button";
import { GlowField } from "@/components/ds/fx";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";
import { RAILWAY_DEPLOY_URL } from "@/lib/site";

const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

type HeroProps = {
  className?: string;
};

/**
 * Crimzon hero: the red planet-horizon backdrop, a pill badge carrying the
 * license line, a two-line 72px Inter Display H1, a subhead, then the primary
 * white CTA + the Railway deploy button, the scaffold command with a copy
 * button, and friction microcopy beneath. The command repeats in the closing
 * CTA on purpose.
 */
export function Hero({ className }: HeroProps): JSX.Element {
  return (
    <section
      className={cn("relative overflow-hidden bg-ink text-white", className)}
    >
      {/* Red planet-horizon backdrop behind all content, dimmed so the
          headline stays the brightest thing on screen. */}
      <GlowField className="opacity-70" />

      <div className="container-page relative z-10 flex flex-col items-center pt-40 pb-36 text-center md:pt-[188px] md:pb-44">
        <Reveal className="flex flex-col items-center">
          <PillBadge>Lifecycle marketing for teams on PostHog</PillBadge>

          <h1 className="mt-8 max-w-6xl font-display font-medium text-5xl text-white leading-[1.02] tracking-[-0.06em] md:text-[72px] md:leading-[74px]">
            PostHog sees it all.
            <br />
            Hogsend acts on it.
          </h1>

          <p className="mt-7 max-w-[560px] text-base text-white/80 leading-6">
            Welcome series, trial nudges, win-backs — the lifecycle emails that
            act on what PostHog already sees. Sent from your own account,
            running on the data you&apos;ve got.
          </p>
        </Reveal>

        <Reveal delay={0.1} className="mt-12 flex flex-col items-center gap-6">
          <div className="flex flex-wrap items-center justify-center gap-5">
            <Button href="/docs/getting-started" variant="accent" icon>
              Start building
            </Button>
            <a
              href={RAILWAY_DEPLOY_URL}
              className="inline-flex rounded-[6px] outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
              <img
                src="https://railway.com/button.svg"
                alt="Deploy on Railway"
                className="h-[42px]"
              />
            </a>
          </div>

          <div className="flex items-center gap-4 rounded-md border border-white/10 bg-white/[0.03] py-2.5 pr-3 pl-4">
            <code className="font-mono text-sm text-white/80">
              <span className="text-accent">$</span> {INSTALL_COMMAND}
            </code>
            <CopyButton value={INSTALL_COMMAND} />
          </div>

          <p className="text-sm text-white/50">
            Free to self-host · No per-contact billing
          </p>
        </Reveal>
      </div>
    </section>
  );
}
