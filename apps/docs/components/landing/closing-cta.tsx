import Image from "next/image";
import Link from "next/link";
import { TrackDeployClick } from "@/components/analytics/track";
import { Eyebrow } from "@/components/ds/badge";
import { Button } from "@/components/ds/button";
import { CopyButton } from "@/components/ds/copy-button";
import { DotGrid } from "@/components/ds/fx";
import { CodeMock } from "@/components/ds/mockup";
import { Reveal } from "@/components/ds/reveal";
import studioJourneys from "@/public/images/studio/studio-journeys.png";
import studioSends from "@/public/images/studio/studio-sends.png";

const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";

const TERMINAL_LINES: Parameters<typeof CodeMock>[0]["lines"] = [
  { text: INSTALL_COMMAND, tone: "accent" },
];

/**
 * ClosingCTA — the crimzon CTA card: one big bordered card with a red glow
 * bleeding from the left; copy + white button + Railway deploy + scaffold
 * terminal on the left, a product collage bleeding off the card edge on the
 * right.
 */
export function ClosingCta({ className }: { className?: string }) {
  return (
    <section
      className={`relative border-hairline-faint border-t text-white ${className ?? ""}`}
    >
      <DotGrid />

      <div className="container-page section-py relative">
        <Reveal>
          <div className="relative overflow-hidden rounded-md border border-white/10 bg-[#070303]">
            {/* Red glow bleeding in from the left edge of the card. */}
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0"
              style={{
                background:
                  "radial-gradient(70% 100% at 0% 60%, rgba(246,72,56,0.22), rgba(246,72,56,0.06) 45%, transparent 70%)",
              }}
            />

            <div className="relative grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr]">
              {/* Left: copy + CTAs + scaffold terminal. */}
              <div className="flex flex-col items-start p-8 md:p-12">
                <Eyebrow className="mb-4">Get started</Eyebrow>

                <h2 className="font-display text-[32px] text-white leading-[1.15] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
                  First send in minutes
                </h2>

                <p className="mt-5 max-w-lg text-base text-white/70 leading-6">
                  The scaffold command sets up the app, Docker, env, and ten
                  journeys — the welcome series included. pnpm bootstrap brings
                  the stack up. Or deploy the Railway template in a click.
                </p>

                <div className="mt-8 w-full max-w-md">
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
                </div>

                <div className="mt-8 flex flex-wrap items-center gap-5">
                  <Button href="/docs/getting-started" variant="accent" icon>
                    Start building
                  </Button>

                  <TrackDeployClick placement="closing-cta">
                    <a
                      href="https://railway.com/deploy/hogsend-posthog-audience-stack"
                      className="inline-flex"
                    >
                      {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
                      <img
                        src="https://railway.com/button.svg"
                        alt="Deploy on Railway"
                        className="h-[42px]"
                      />
                    </a>
                  </TrackDeployClick>

                  <Link
                    href="/docs"
                    className="text-base text-white/70 transition-colors hover:text-white"
                  >
                    or read the docs first →
                  </Link>
                </div>

                <p className="mt-6 text-sm text-white/50">
                  Free to self-host · PostHog + your provider · no per-contact
                  pricing
                </p>
              </div>

              {/* Right: product collage bleeding off the card edge. */}
              <div
                aria-hidden="true"
                className="relative hidden min-h-[400px] lg:block"
              >
                <div className="absolute top-12 left-6 w-[120%] rotate-[-2deg] overflow-hidden rounded-[10px] border border-white/10 shadow-2xl shadow-black/60">
                  <Image
                    src={studioJourneys}
                    alt=""
                    placeholder="blur"
                    sizes="40vw"
                    className="h-auto w-full"
                  />
                </div>
                <div className="absolute bottom-[-8%] left-24 w-[120%] rotate-[1.5deg] overflow-hidden rounded-[10px] border border-white/10 shadow-2xl shadow-black/60">
                  <Image
                    src={studioSends}
                    alt=""
                    placeholder="blur"
                    sizes="40vw"
                    className="h-auto w-full"
                  />
                </div>
              </div>
            </div>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
