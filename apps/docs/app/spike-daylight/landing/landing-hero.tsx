"use client";

import { AgentPromptLoop } from "@/app/(landing)/_components/agent-prompt-loop";
import { PsNav } from "@/app/(landing)/_components/nav";
import { type BrandKey, BrandLogo } from "@/components/ds/brand-logo";
import { CopyButton } from "@/components/ds/copy-button";
import { LogoMarquee } from "@/components/ds/marquee";
import { ThermalHover } from "@/components/ds/thermal";
import { cn } from "@/lib/cn";
import { FieldStage } from "../dayfield-shared";
import { getFieldConfig } from "../field-config";

/* ==========================================================================
 *  The Hogsend homepage hero, moved onto the day-field.
 *  Reuses the live agent-session terminal, install command and works-with strip
 *  — only the backdrop changes: the thermal smoke becomes a hand-painted vista
 *  lit to the visitor's local hour, with a day-arc scrubber to preview any hour.
 *
 *  `DayfieldHeroSection` is nav-less and self-contained: the caller renders a
 *  `<PsNav fixed glass />` overlay so the vista sits full-bleed behind it. The
 *  real homepage swaps to this behind `?hero=field`.
 * ========================================================================== */

const INSTALL_COMMAND = "pnpm dlx create-hogsend@latest my-app";
const DISPLAY = "[font-family:var(--ff-display)]";

const WORKS_WITH = [
  "posthog",
  "resend",
  "twilio",
  "stripe",
  "railway",
  "typescript",
  "segment",
  "slack",
] as const satisfies readonly BrandKey[];

/** The hero section only — no nav (the caller overlays `<PsNav fixed glass/>`).
 *  `config` swaps the backdrop (vista by default, the match-day stadium on the
 *  final, any future holiday) while the marketing content stays identical. */
export function DayfieldHeroSection({
  engineVersion,
  configId,
  initialHour,
  controls = false,
}: {
  engineVersion: string;
  /** serializable config id (resolved client-side); defaults to the vista. */
  configId?: string;
  initialHour?: number;
  controls?: boolean;
}) {
  const config = getFieldConfig(configId);
  return (
    <section className="relative h-[100svh] min-h-[760px] overflow-hidden text-white">
      <FieldStage
        config={config}
        variant="stage"
        initialHour={initialHour}
        controls={controls}
      >
        {/* centered hero column — reserve room for the day-arc bar only when
            the preview scrubber is actually shown; for a normal visitor that
            row is hidden, so we drop the gap and let the works-with strip sit
            at the base of the hero with the open-source row directly beneath. */}
        <div
          className={cn(
            "absolute inset-0 z-20 flex flex-col items-center",
            controls ? "pb-[124px]" : "pb-8",
          )}
        >
          <div className="dayfield-rise mx-auto flex w-full max-w-[1256px] flex-1 flex-col items-center justify-center px-6 pt-16 text-center md:px-10">
            {/* announcement pill */}
            <a
              href="https://course.hogsend.com"
              className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 py-1 pr-3 pl-1 text-[12px] text-white backdrop-blur-md sm:text-[13px]"
            >
              <span className="rounded-full bg-[#f64838] px-2.5 py-0.5 font-medium text-white">
                New Course
              </span>
              <span className="font-medium">Measure → Keep → Grow</span>
              <span className="text-white/50">· Live</span>
            </a>

            <h1
              className={cn(
                "mt-6 max-w-[820px] text-balance font-normal text-[38px] leading-[1.05] tracking-[-0.03em] md:mt-8 md:text-[66px] md:leading-[1.02]",
                DISPLAY,
              )}
              style={{ textShadow: "0 2px 44px rgba(5,1,1,0.55)" }}
            >
              Your customer lifecycle belongs in your repo.
            </h1>

            <p className="mt-5 max-w-[660px] text-[16px] leading-relaxed text-white/80 md:mt-6 md:text-lg">
              The lifecycle automation framework for growth engineering teams —
              and their agents — that ship code-first. Journeys live in your
              repo, reviewed and versioned like the rest of your product.
            </p>

            {/* install command — wrapped in the sun-kiss cursor glow so the
                hairline border warms where the pointer rides it. */}
            <div className="mt-7 md:mt-8">
              <ThermalHover intensity="bold">
                <span className="flex min-w-0 items-center gap-2 rounded-[6px] border border-white/15 bg-black/35 py-2 pr-2 pl-4 backdrop-blur-md">
                  <code className="min-w-0 overflow-x-auto whitespace-nowrap font-mono text-[13px] text-white/90 [scrollbar-width:none]">
                    <span className="text-white/40">$ </span>
                    {INSTALL_COMMAND}
                  </code>
                  <CopyButton
                    value={INSTALL_COMMAND}
                    className="shrink-0 text-white/50 hover:text-white"
                  />
                </span>
              </ThermalHover>
            </div>

            {/* the agent-session terminal — frosted glass over the vista. The
                real AgentPromptLoop hardcodes bg-[#0a0606]; we translucent its
                [data-prompt-surface] shell here (not the shared component) and
                reset text-left, since the hero column is centered. */}
            <div className="dayfield-terminal relative mt-9 w-full max-w-[620px] text-left md:mt-11">
              <style>{`
                /* A near-solid dark terminal that still drinks a hint of the
                   scene: a mostly-opaque ink tint (so the mono feed reads and
                   the empty scrollport isn't a see-through hollow) over a blur
                   that lets only the edges whisper the vista through — a window
                   framing the scene, not a muddy glass box floating on it. */
                .dayfield-terminal [data-prompt-surface] {
                  background-color: rgba(20,16,17,0.88) !important;
                  backdrop-filter: blur(26px) saturate(1.15) brightness(1);
                  -webkit-backdrop-filter: blur(26px) saturate(1.15) brightness(1);
                  border-color: rgba(255,255,255,0.14) !important;
                  box-shadow: 0 24px 70px -28px rgba(0,0,0,0.75);
                }
                /* a faint top-light sheen so the glass reads as a surface */
                .dayfield-terminal [data-prompt-surface]::before {
                  content: "";
                  position: absolute; inset: 0;
                  border-radius: inherit;
                  background: linear-gradient(160deg, rgba(255,255,255,0.06), rgba(255,255,255,0) 40%);
                  pointer-events: none;
                }
              `}</style>
              <div
                aria-hidden="true"
                className="-inset-x-16 -inset-y-10 pointer-events-none absolute"
                style={{
                  background:
                    "radial-gradient(45% 60% at 30% 60%, rgba(246,72,56,0.18), transparent 70%), radial-gradient(40% 55% at 75% 40%, rgba(35,196,137,0.16), transparent 70%)",
                  filter: "blur(26px)",
                }}
              />
              <ThermalHover rounded="rounded-xl" intensity="bold">
                <AgentPromptLoop engineVersion={engineVersion} />
              </ThermalHover>
            </div>

            <p className="mt-5 max-w-[760px] font-mono text-[11px] uppercase leading-5 tracking-[0.06em] text-white/55 md:text-[12px]">
              Onboarding · Trial conversion · Payment recovery · Retention ·
              Win-back · Across email, in-app, SMS, Discord, and more
            </p>
          </div>

          {/* works-with strip, sitting just above the day arc */}
          <div
            className="dayfield-rise w-full"
            style={{ animationDelay: "120ms" }}
          >
            <div className="mx-auto flex max-w-[1256px] items-center gap-8 px-6 pb-2 md:px-10">
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-[0.08em] text-white/45">
                Works with
              </span>
              <div className="relative min-w-0 flex-1 opacity-75 grayscale">
                <LogoMarquee
                  items={WORKS_WITH.map((brand) => (
                    <BrandLogo
                      key={brand}
                      brand={brand}
                      height={22}
                      className="mx-8 text-white/70"
                    />
                  ))}
                />
              </div>
            </div>
          </div>
        </div>
      </FieldStage>
    </section>
  );
}

/** Standalone spike page: the section under a fixed glass nav, plus a hint of
 *  the dark page below so it reads as a real hero swap. */
export function LandingHero({ engineVersion }: { engineVersion: string }) {
  return (
    <main className="bg-[#050101] text-white">
      <PsNav fixed glass />
      <DayfieldHeroSection engineVersion={engineVersion} controls />

      <section className="relative border-[#f6483826] border-t">
        <div className="mx-auto max-w-[1256px] px-6 py-20 md:px-10 md:py-28">
          <p className="font-mono text-[12px] uppercase tracking-[0.12em] text-[#f64838]">
            ▲ Below the fold
          </p>
          <h2
            className={cn(
              "mt-4 max-w-[720px] text-balance text-[30px] leading-[1.1] tracking-[-0.03em] md:text-[42px]",
              DISPLAY,
            )}
          >
            The page returns to the dark crimzon ground — the hero is the only
            thing that opened a window.
          </h2>
          <p className="mt-5 max-w-[620px] text-white/60">
            Everything else stays exactly as it is today. The living vista is a
            single, self-contained swap for the hero backdrop.
          </p>
        </div>
      </section>
    </main>
  );
}
