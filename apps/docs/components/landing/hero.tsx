import type { JSX } from "react";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CopyButton } from "@/components/ds/copy-button";
import { GlowField } from "@/components/ds/fx";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import { cn } from "@/lib/cn";

// The one-liner that scaffolds a new app, shown as the hero terminal.
const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

const TERMINAL_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  { text: INSTALL_COMMAND, tone: "accent" },
];

type HeroProps = {
  className?: string;
};

export function Hero({ className }: HeroProps): JSX.Element {
  return (
    <section
      className={cn("relative overflow-hidden bg-ink text-white", className)}
    >
      {/* Luminous green hero backdrop behind all content. */}
      <GlowField />

      <div className="container-page relative z-10 flex flex-col items-center pt-32 pb-20 text-center">
        <Reveal className="flex flex-col items-center">
          <Eyebrow tone="dark">
            Open source · self-hosted · yours to run
          </Eyebrow>

          <h1 className="mt-7 max-w-4xl font-display text-5xl leading-[1.05] md:text-7xl">
            The right email at exactly{" "}
            <span className="text-white/55">the right moment</span>
          </h1>

          <p className="mt-6 max-w-2xl text-lg text-white/60">
            PostHog already knows what your users do. Resend already sends your
            mail. Hogsend is the lifecycle layer in between — the right message
            fires on its own, every send flows back to your tools, and the whole
            thing lives in your repo as TypeScript you own. No new platform, no
            drag-and-drop.
          </p>
        </Reveal>

        <Reveal
          delay={0.1}
          className="mt-9 flex flex-wrap items-center justify-center gap-4"
        >
          <Button href="/docs" variant="accent" icon>
            Read the docs
          </Button>

          <a
            href="https://railway.com/deploy/LxSCyR?referralCode=dougie"
            className="inline-flex"
          >
            {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
            <img
              src="https://railway.com/button.svg"
              alt="Deploy on Railway"
              className="h-[42px]"
            />
          </a>
        </Reveal>

        <Reveal delay={0.18} className="mt-14 w-full max-w-2xl">
          <div className="relative">
            <CodeMock
              lines={TERMINAL_LINES}
              filename="terminal"
              className="text-left"
            />
            <CopyButton
              value={INSTALL_COMMAND}
              className="absolute top-2 right-3"
            />
          </div>
        </Reveal>
      </div>
    </section>
  );
}
