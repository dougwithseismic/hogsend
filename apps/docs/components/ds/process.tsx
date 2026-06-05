"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/cn";

type Step = {
  n: string;
  title: string;
  description: string;
  media?: React.ReactNode;
};

type ProcessStepsProps = {
  steps: Step[];
  /**
   * `light` = on the cream canvas (ink text, ink hairlines). `dark` = on a dark
   * rounded panel (cream/lumen text, lumen hairlines). Amber (`glow`) is the
   * active accent in both.
   */
  tone?: "dark" | "light";
  className?: string;
};

export function ProcessSteps({
  steps,
  tone = "dark",
  className,
}: ProcessStepsProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const isDark = tone === "dark";
  const active = steps[activeIndex] ?? steps[0];

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] lg:gap-14",
        className,
      )}
    >
      {/* Left numbered accordion */}
      <div
        className={cn("border-t", isDark ? "border-lumen/10" : "border-ink/12")}
      >
        {steps.map((step, index) => {
          const isOpen = index === activeIndex;
          return (
            <div
              key={step.n}
              className={cn(
                "border-b",
                isDark ? "border-lumen/10" : "border-ink/12",
              )}
            >
              <h3>
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => setActiveIndex(index)}
                  className={cn(
                    "flex w-full items-start gap-4 py-6 text-left outline-none transition-colors",
                    isDark
                      ? "focus-visible:text-lumen"
                      : "focus-visible:text-ink",
                  )}
                >
                  {/* Amber step-number chip */}
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-0.5 grid size-7 shrink-0 place-items-center rounded-md font-mono text-[13px] tabular-nums transition-colors",
                      isOpen
                        ? "bg-glow/15 text-glow"
                        : isDark
                          ? "bg-lumen/[0.06] text-lumen/40"
                          : "bg-ink/[0.05] text-ink/40",
                    )}
                  >
                    {step.n}
                  </span>
                  <span className="flex-1">
                    <span
                      className={cn(
                        "block font-display text-xl leading-tight tracking-tight transition-colors md:text-2xl",
                        isOpen
                          ? isDark
                            ? "text-lumen"
                            : "text-ink"
                          : isDark
                            ? "text-lumen/70"
                            : "text-ink/70",
                      )}
                    >
                      {step.title}
                    </span>
                    <AnimatePresence initial={false}>
                      {isOpen ? (
                        <motion.span
                          key="desc"
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: "auto", opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={{ duration: 0.3, ease: "easeOut" }}
                          className="block overflow-hidden"
                        >
                          <span
                            className={cn(
                              "block pt-3 text-base leading-relaxed",
                              isDark ? "text-lumen/60" : "text-ink/60",
                            )}
                          >
                            {step.description}
                          </span>
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </span>
                </button>
              </h3>
            </div>
          );
        })}
      </div>

      {/* Right media panel for active step */}
      <div className="relative min-h-[18rem]">
        <AnimatePresence mode="wait">
          <motion.div
            key={active?.n}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="min-w-0"
          >
            {active?.media}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
