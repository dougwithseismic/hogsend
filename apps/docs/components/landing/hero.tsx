import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CopyButton } from "@/components/ds/copy-button";
import { CurvedText } from "@/components/ds/curved-text";
import { PulsePill } from "@/components/ds/pulse-pill";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

// The one-liner that scaffolds a new app, shown as the hero terminal chip.
const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

// Hogsend's lifecycle vocabulary, laid around the centerpiece ring. The mono
// caps + bullets read as a slow-drifting "events → journeys → sends" loop.
const RING_TEXT =
  "signed_up · welcome journey · milestone_hit · ctx.sleep · trial_ending · re-engage · ";

type HeroProps = {
  className?: string;
};

/**
 * Cream, centered hero (Wispr Flow homage). A two-tone light-serif headline
 * sits over a Figtree subtitle and a lavender/white button pair; the
 * centerpiece is a slow amber `CurvedText` ring of Hogsend's lifecycle
 * vocabulary wrapping a `PulsePill` terminal chip for the scaffold command.
 */
export function Hero({ className }: HeroProps): JSX.Element {
  return (
    <section className={cn("relative overflow-hidden", className)}>
      <div className="container-page relative z-10 flex flex-col items-center pt-32 pb-24 text-center md:pt-40">
        <Reveal className="flex flex-col items-center">
          <Eyebrow tone="light">Lifecycle email as plain TypeScript</Eyebrow>

          <h1
            className="mt-7 max-w-[14ch] font-display font-normal tracking-[-0.04em]"
            style={{
              fontSize: "clamp(3.25rem, 9vw, 7.5rem)",
              lineHeight: 0.9,
            }}
          >
            <span className="text-ink-soft">Don&apos;t drag-and-drop,</span>{" "}
            <span className="text-ink">just write code.</span>
          </h1>

          <p className="mt-7 max-w-2xl text-lg leading-relaxed text-ink/70">
            Hogsend turns PostHog events into Resend emails as plain TypeScript
            — journeys, waits, and buckets are functions you read in your
            editor, not boxes you wire on a canvas or YAML you hand-edit.
          </p>
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-9 flex flex-wrap items-center justify-center gap-4"
        >
          <Button href="/docs" variant="accent" icon>
            Get started
          </Button>

          <Button href="/docs" variant="outline">
            Read the docs
          </Button>
        </Reveal>

        <Reveal delay={0.16}>
          <p className="mt-6 font-mono text-[0.75rem] tracking-wide text-ink/50">
            Open source · self-hosted · PostHog + Resend
          </p>
        </Reveal>

        {/* Centerpiece: an amber ring of lifecycle vocabulary drifting around a
            terminal chip with the scaffold command. */}
        <Reveal
          delay={0.24}
          className="relative mt-20 flex aspect-square w-full max-w-[26rem] items-center justify-center sm:max-w-[30rem]"
        >
          <CurvedText
            text={RING_TEXT.repeat(2)}
            radius={150}
            className="absolute inset-0 h-full w-full opacity-90"
          />

          <div className="relative flex items-center gap-2 rounded-full border-2 border-ink bg-paper py-1.5 pr-2 pl-4 shadow-[0_2px_0_0_var(--color-ink)]">
            <PulsePill className="border-0 bg-transparent px-0 py-0">
              <span className="text-ink/40">$</span> {INSTALL_COMMAND}
            </PulsePill>
            <CopyButton
              value={INSTALL_COMMAND}
              className="text-ink/40 hover:text-ink"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
