"use client";

import { Plus } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
import { cn } from "@/lib/cn";

type FaqItem = {
  q: string;
  a: string;
};

type FaqAccordionProps = {
  items: FaqItem[];
  /** Accepted for compatibility — every tone renders the dark crimzon style. */
  tone?: "dark" | "light";
  className?: string;
};

/**
 * Crimzon FAQ accordion: stacked 6px-radius rows (white/2% fill, white/8
 * hairline, 24px padding, 16px gap) with a + icon that rotates to × on open.
 */
export function FaqAccordion({
  items,
  tone: _tone,
  className,
}: FaqAccordionProps) {
  const [openIndex, setOpenIndex] = useState<number>(0);

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {items.map((item, index) => {
        const isOpen = index === openIndex;
        const panelId = `faq-panel-${index}`;
        const buttonId = `faq-button-${index}`;
        return (
          <div
            key={item.q}
            className="rounded-md border border-white/[0.08] bg-white/[0.02] transition-colors duration-200 hover:border-white/15"
          >
            <h3>
              <button
                type="button"
                id={buttonId}
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => {
                  // Which questions get opened is an objections map — track
                  // opens only, not closes.
                  if (!isOpen) {
                    capture(AnalyticsEvent.FAQ_OPENED, { question: item.q });
                  }
                  setOpenIndex(isOpen ? -1 : index);
                }}
                className="flex w-full items-center gap-4 p-6 text-left text-white outline-none transition-colors focus-visible:text-accent"
              >
                <span className="flex-1 font-medium font-sans text-base leading-snug tracking-[-0.02em] md:text-lg">
                  {item.q}
                </span>
                <span
                  aria-hidden="true"
                  className={cn(
                    "flex h-6 w-6 shrink-0 items-center justify-center transition-transform duration-200",
                    isOpen ? "rotate-45 text-accent" : "text-white/50",
                  )}
                >
                  <Plus size={18} strokeWidth={1.5} />
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
                  <p className="max-w-2xl px-6 pb-6 text-base text-white/70 leading-6">
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
