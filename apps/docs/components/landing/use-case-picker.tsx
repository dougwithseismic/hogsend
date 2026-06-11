"use client";

import { ArrowUpRight } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { type JSX, type ReactNode, useState } from "react";
import { Reveal } from "@/components/ds/reveal";
import { Section, SectionHeading } from "@/components/ds/section";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

/**
 * UseCasePicker — chip row that swaps a real `defineJourney()` sample in a
 * code window, plus a Resend/Postmark toggle on the `.env` strip beneath it.
 * The journey code never changes with the provider — that's the point, and
 * the strip says so honestly.
 *
 * `CodeHighlight` is an async RSC, so the highlighted nodes are rendered in
 * `app/(home)/page.tsx` and passed in as props (same RSC-composition pattern
 * as BuildingBlocks → TabbedShowcase).
 */

export type UseCaseValue = "onboarding" | "trial_conversion" | "winback";
export type ProviderValue = "resend" | "postmark";

type UseCaseMeta = {
  label: string;
  filename: string;
  href: string;
};

const USE_CASE_ORDER: readonly UseCaseValue[] = [
  "onboarding",
  "trial_conversion",
  "winback",
];

const USE_CASES: Record<UseCaseValue, UseCaseMeta> = {
  onboarding: {
    label: "Onboarding",
    filename: "src/journeys/onboarding.ts",
    href: "/use-cases/onboarding",
  },
  trial_conversion: {
    label: "Trial conversion",
    filename: "src/journeys/trial-conversion.ts",
    href: "/use-cases/trial-conversion",
  },
  winback: {
    label: "Win-back",
    filename: "src/journeys/winback.ts",
    href: "/use-cases/winback",
  },
};

const PROVIDER_ORDER: readonly ProviderValue[] = ["resend", "postmark"];

const PROVIDER_LABELS: Record<ProviderValue, string> = {
  resend: "Resend",
  postmark: "Postmark",
};

const CHIP_CLASS = cn(
  "h-10 select-none rounded-[10px] border px-4 text-sm",
  "transition-colors duration-200 outline-none",
  "focus-visible:border-white/30",
);

type UseCasePickerProps = {
  /** Highlighted journey samples, keyed by use case. */
  journeys: Record<UseCaseValue, ReactNode>;
  /** Highlighted `.env` snippets, keyed by provider. */
  envs: Record<ProviderValue, ReactNode>;
};

export function UseCasePicker({
  journeys,
  envs,
}: UseCasePickerProps): JSX.Element {
  const [useCase, setUseCase] = useState<UseCaseValue>("onboarding");
  const [provider, setProvider] = useState<ProviderValue>("resend");
  const active = USE_CASES[useCase];

  function handleUseCase(next: UseCaseValue): void {
    if (next === useCase) return;
    setUseCase(next);
    capture(AnalyticsEvent.USE_CASE_SELECTED, { use_case: next });
  }

  function handleProvider(next: ProviderValue): void {
    if (next === provider) return;
    setProvider(next);
    capture(AnalyticsEvent.PROVIDER_SELECTED, { provider: next });
  }

  return (
    <Section id="journeys-in-code">
      <Reveal>
        <SectionHeading
          eyebrow="The code"
          title="Pick a use case, read the journey"
          subtitle="Each flow is one TypeScript file — trigger, durable waits, branches. Swap the provider underneath; the journey doesn't change."
        />
      </Reveal>

      <Reveal delay={0.1} className="mt-12">
        {/* Use-case chips */}
        <div
          role="tablist"
          aria-orientation="horizontal"
          aria-label="Use case"
          className="flex flex-wrap gap-2"
        >
          {USE_CASE_ORDER.map((value) => {
            const isActive = value === useCase;
            return (
              <button
                key={value}
                type="button"
                role="tab"
                id={`usecase-tab-${value}`}
                aria-selected={isActive}
                aria-controls={`usecase-panel-${value}`}
                onClick={() => handleUseCase(value)}
                className={cn(
                  CHIP_CLASS,
                  isActive
                    ? "border-white/25 bg-white/[0.06] text-white"
                    : "border-white/[0.08] bg-white/[0.02] text-white/60 hover:border-white/20 hover:text-white",
                )}
              >
                {USE_CASES[value].label}
              </button>
            );
          })}
        </div>

        {/* Code window */}
        <div className="relative mt-6">
          {/* Red atmospheric bloom behind the glass panel. */}
          <div
            aria-hidden="true"
            className="-inset-x-10 -inset-y-6 pointer-events-none absolute"
            style={{
              background:
                "radial-gradient(60% 60% at 50% 65%, rgba(246, 72, 56, 0.14), transparent 70%)",
              filter: "blur(40px)",
            }}
          />
          <div className="relative overflow-hidden rounded-[10px] border border-white/10 bg-[#0a0606]">
            <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-2.5">
              <div aria-hidden="true" className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
              </div>
              <span className="font-mono text-[11px] text-white/40 tracking-wide">
                {active.filename}
              </span>
            </div>

            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={useCase}
                role="tabpanel"
                id={`usecase-panel-${useCase}`}
                aria-labelledby={`usecase-tab-${useCase}`}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                transition={{ duration: 0.25, ease: "easeOut" }}
                className="px-4 py-4"
              >
                {journeys[useCase]}
              </motion.div>
            </AnimatePresence>

            {/* .env strip — provider choice is config, not journey code. */}
            <div className="border-white/[0.08] border-t bg-white/[0.02]">
              <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
                <span className="font-mono text-[11px] text-white/40 tracking-wide">
                  .env
                </span>
                <fieldset
                  aria-label="Email provider"
                  className="flex items-center gap-1 rounded-[10px] border border-white/[0.08] bg-white/[0.02] p-1"
                >
                  {PROVIDER_ORDER.map((value) => {
                    const isActive = value === provider;
                    return (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={isActive}
                        onClick={() => handleProvider(value)}
                        className={cn(
                          "select-none rounded-[7px] px-2.5 py-1 text-xs outline-none transition-colors duration-200",
                          isActive
                            ? "bg-white/[0.08] text-white"
                            : "text-white/50 hover:text-white",
                        )}
                      >
                        {PROVIDER_LABELS[value]}
                      </button>
                    );
                  })}
                </fieldset>
              </div>
              <AnimatePresence mode="wait" initial={false}>
                <motion.div
                  key={provider}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="px-4 pb-3"
                >
                  {envs[provider]}
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>

        {/* Footer row — caption left, deep link right */}
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-white/50 leading-6">
            Shortened from the full journey — the API is real, the provider
            lives in config.
          </p>
          <Link
            href={active.href}
            className="group inline-flex items-center gap-1.5 text-sm text-white/60 transition-colors hover:text-white"
          >
            Read the use case
            <ArrowUpRight
              aria-hidden="true"
              className="size-4 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={1.5}
            />
          </Link>
        </div>
      </Reveal>
    </Section>
  );
}
