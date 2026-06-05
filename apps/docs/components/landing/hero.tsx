import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CopyButton } from "@/components/ds/copy-button";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

// The one-liner that scaffolds a new app, shown as the hero terminal chip.
const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

type HeroProps = {
  className?: string;
};

/**
 * Cream, centered hero (neapolitan skin). A two-tone light-serif headline over a
 * Figtree subtitle; below the headline sits the large scaffold-command pill, and
 * below that the grape/white button pair.
 */
export function Hero({ className }: HeroProps): JSX.Element {
  return (
    <section className={cn("relative overflow-hidden", className)}>
      <div className="container-page relative z-10 flex flex-col items-center pt-32 pb-24 text-center md:pt-40">
        <Reveal className="flex flex-col items-center">
          <Eyebrow tone="light">Lifecycle email as plain TypeScript</Eyebrow>

          <h1
            className="mt-7 max-w-[18ch] font-display font-normal tracking-[-0.035em]"
            style={{
              fontSize: "clamp(2.75rem, 6.8vw, 5.75rem)",
              lineHeight: 0.95,
            }}
          >
            <span className="text-ink-soft">Email automation for</span>{" "}
            <span className="text-ink">scrappy product engineers</span>
          </h1>

          <p className="mt-7 max-w-3xl text-lg leading-relaxed text-ink/70">
            PostHog already knows what your users do. Your email provider
            already sends the mail. Hogsend is the piece that connects them — so
            when someone signs up, hits a milestone, or goes quiet, the right
            message goes out on its own.
          </p>
        </Reveal>

        {/* The scaffold command — the hero's focal chip, between the headline and
            the buttons. A large mono terminal pill, no ring. */}
        <Reveal delay={0.12} className="mt-12 w-full max-w-3xl">
          <div className="mx-auto flex w-fit max-w-full items-center gap-4 rounded-full border-2 border-ink bg-paper py-3.5 pr-3.5 pl-7 shadow-[0_4px_0_0_var(--color-ink)]">
            <code className="overflow-x-auto whitespace-nowrap font-mono text-base text-ink sm:text-lg md:text-2xl">
              <span className="text-glow">$</span>{" "}
              <span className="text-ink/45">pnpm dlx</span>{" "}
              create-hogsend@latest <span className="text-ink/45">my-app</span>
            </code>
            <CopyButton
              value={INSTALL_COMMAND}
              className="shrink-0 text-ink/40 hover:text-ink"
            />
          </div>
        </Reveal>

        <Reveal
          delay={0.18}
          className="mt-10 flex flex-wrap items-center justify-center gap-4"
        >
          <Button href="/docs" variant="accent" icon>
            Get started
          </Button>

          <Button href="/docs" variant="outline">
            Read the docs
          </Button>
        </Reveal>

        <Reveal delay={0.24}>
          <p className="mt-6 font-mono text-[0.75rem] tracking-wide text-ink/50">
            Open source · self-hosted · works with any email provider
          </p>
        </Reveal>
      </div>
    </section>
  );
}
