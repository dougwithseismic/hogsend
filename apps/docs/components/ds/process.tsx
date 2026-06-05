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
        className={cn(
          "border-t",
          isDark ? "border-white/[0.08]" : "border-black/[0.08]",
        )}
      >
        {steps.map((step, index) => {
          const isOpen = index === activeIndex;
          return (
            <div
              key={step.n}
              className={cn(
                "border-b",
                isDark ? "border-white/[0.08]" : "border-black/[0.08]",
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
                      ? "focus-visible:text-white"
                      : "focus-visible:text-black",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "mt-[7px] h-[7px] w-[7px] shrink-0 rounded-[2px] transition-colors",
                      isOpen
                        ? "bg-accent"
                        : isDark
                          ? "bg-white/20"
                          : "bg-black/20",
                    )}
                  />
                  <span className="flex-1">
                    <span
                      className={cn(
                        "block font-display text-xl leading-tight transition-colors md:text-2xl",
                        isOpen
                          ? isDark
                            ? "text-white"
                            : "text-black"
                          : isDark
                            ? "text-white/70"
                            : "text-black/70",
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
                              isDark ? "text-white/60" : "text-black/60",
                            )}
                          >
                            {step.description}
                          </span>
                        </motion.span>
                      ) : null}
                    </AnimatePresence>
                  </span>
                  <span
                    aria-hidden="true"
                    className={cn(
                      "shrink-0 font-mono text-sm tabular-nums transition-colors",
                      isOpen
                        ? "text-accent"
                        : isDark
                          ? "text-white/40"
                          : "text-black/40",
                    )}
                  >
                    {step.n}
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
