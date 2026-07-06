"use client";

import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { type JSX, type ReactNode, useState } from "react";
import { CopyButton } from "@/components/ds/copy-button";
import { cn } from "@/lib/cn";

/**
 * Light-chrome port of the homepage UseCasePicker: Polar-style outline chips
 * swap a real defineJourney() sample inside a dark code window; a
 * Resend/Postmark toggle swaps the `.env` strip beneath it (the journey code
 * never changes — that's the point). `CodeHighlight` is an async RSC, so the
 * highlighted nodes are rendered in the page and passed in as props.
 */

export type UseCaseValue =
  | "onboarding"
  | "trial_conversion"
  | "winback"
  | "community";
export type ProviderValue = "resend" | "postmark";

const USE_CASE_ORDER: readonly UseCaseValue[] = [
  "onboarding",
  "trial_conversion",
  "winback",
  "community",
];

const USE_CASES: Record<
  UseCaseValue,
  { label: string; filename: string; href: string }
> = {
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
  community: {
    label: "Discord + in-app",
    filename: "src/journeys/milestone.ts",
    href: "/use-cases/community",
  },
};

const PROVIDER_ORDER: readonly ProviderValue[] = ["resend", "postmark"];
const PROVIDER_LABELS: Record<ProviderValue, string> = {
  resend: "Resend",
  postmark: "Postmark",
};

type PsCodePickerProps = {
  journeys: Record<UseCaseValue, ReactNode>;
  envs: Record<ProviderValue, ReactNode>;
  /** Raw sources, for the copy button. */
  raw: Record<UseCaseValue, string>;
};

export function PsCodePicker({
  journeys,
  envs,
  raw,
}: PsCodePickerProps): JSX.Element {
  const [useCase, setUseCase] = useState<UseCaseValue>("onboarding");
  const [provider, setProvider] = useState<ProviderValue>("resend");
  const active = USE_CASES[useCase];

  return (
    <div>
      {/* Use-case chips — Polar outline chips, solid-ink when active. */}
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
              id={`ps-usecase-tab-${value}`}
              aria-selected={isActive}
              aria-controls={`ps-usecase-panel-${value}`}
              onClick={() => setUseCase(value)}
              className={cn(
                "select-none rounded-[6px] border px-4 py-2 font-medium text-sm tracking-[-0.025em] outline-none transition-colors duration-200",
                isActive
                  ? "border-white bg-white text-[#0a0a0a]"
                  : "border-white/10 bg-white/[0.04] text-white/75 hover:border-white/30",
              )}
            >
              {USE_CASES[value].label}
            </button>
          );
        })}
      </div>

      {/* Dark code window on the light page — the Polar terminal idiom. */}
      <div className="mt-6 overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
        <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-0">
          <div aria-hidden="true" className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
            <span className="size-2.5 rounded-full bg-white/15" />
          </div>
          {/* Active-file tab */}
          <span className="border-[#f64838] border-b-2 py-2.5 font-mono text-[11px] text-white/75 tracking-wide">
            {active.filename}
          </span>
          <span className="ml-auto flex items-center gap-3 py-2.5">
            <span className="rounded-[4px] bg-white/[0.06] px-1.5 py-0.5 font-mono text-[10px] text-white/40 uppercase tracking-[0.08em]">
              ts
            </span>
            <CopyButton value={raw[useCase]} />
          </span>
        </div>

        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={useCase}
            role="tabpanel"
            id={`ps-usecase-panel-${useCase}`}
            aria-labelledby={`ps-usecase-tab-${useCase}`}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.25, ease: "easeOut" }}
            className="ps-code px-4 py-4"
          >
            {journeys[useCase]}
          </motion.div>
        </AnimatePresence>

        {/* .env strip — provider choice is config, not journey code. */}
        <div className="border-white/[0.08] border-t bg-white/[0.03]">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 pt-3">
            <span className="font-mono text-[11px] text-white/40 tracking-wide">
              .env
            </span>
            <fieldset
              aria-label="Email provider"
              className="flex items-center gap-1 rounded-[6px] border border-white/[0.08] bg-white/[0.02] p-1"
            >
              {PROVIDER_ORDER.map((value) => {
                const isActive = value === provider;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={isActive}
                    onClick={() => setProvider(value)}
                    className={cn(
                      "select-none rounded-[4px] px-2.5 py-1 font-mono text-xs outline-none transition-colors duration-200",
                      isActive
                        ? "bg-white/[0.1] text-white"
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

      {/* Footer row — caption left, deep link right. */}
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <p className="text-white/55 text-sm tracking-[-0.02em]">
          Shortened from the full journey — the API is real, the provider lives
          in config.
        </p>
        <Link
          href={active.href}
          className="font-medium text-white text-sm tracking-[-0.025em] hover:opacity-70"
        >
          Read the use case →
        </Link>
      </div>
    </div>
  );
}
