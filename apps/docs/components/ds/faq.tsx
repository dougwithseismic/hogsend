"use client";

import { Plus, X } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/cn";

type FaqItem = {
  q: string;
  a: string;
};

type FaqAccordionProps = {
  items: FaqItem[];
  /**
   * `light` = on the cream canvas (ink text + ink hairlines). `dark` = on a
   * dark panel (cream/lumen text + lumen hairlines). Amber (`glow`) is the
   * open/focus accent in both.
   */
  tone?: "dark" | "light";
  className?: string;
};

export function FaqAccordion({
  items,
  tone = "dark",
  className,
}: FaqAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number>(0);
  const isDark = tone === "dark";

  return (
    <div
      className={cn(
        "border-t",
        isDark ? "border-lumen/10" : "border-ink/12",
        className,
      )}
    >
      {items.map((item, index) => {
        const isOpen = index === openIndex;
        const panelId = `faq-panel-${index}`;
        const buttonId = `faq-button-${index}`;
        const Icon = isOpen ? X : Plus;
        return (
          <div
            key={item.q}
            className={cn(
              "border-b",
              isDark ? "border-lumen/10" : "border-ink/12",
            )}
          >
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpenIndex(isOpen ? -1 : index)}
                className={cn(
                  "flex w-full items-center gap-4 py-6 text-left outline-none transition-colors",
                  isDark
                    ? "text-lumen focus-visible:text-glow"
                    : "text-ink focus-visible:text-glow",
                )}
              >
                <span className="flex-1 font-display text-lg leading-snug tracking-tight md:text-xl">
                  {item.q}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center transition-colors",
                    isOpen
                      ? "text-glow"
                      : isDark
                        ? "text-lumen/50"
                        : "text-ink/50",
                  )}
                >
                  <Icon size={18} strokeWidth={1.5} />
                </span>
              </button>
            </h3>
            <AnimatePresence initial={false}>
              {isOpen ? (
                <motion.div
                  key="content"
                  id={panelId}
                  role="region"
                  aria-labelledby={buttonId}
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: "auto", opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.3, ease: "easeOut" }}
                  className="overflow-hidden"
                >
                  <p
                    className={cn(
                      "max-w-2xl pr-10 pb-6 text-base leading-relaxed",
                      isDark ? "text-lumen/60" : "text-ink/60",
                    )}
                  >
                    {item.a}
                  </p>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}
