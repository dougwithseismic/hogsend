"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { cn } from "@/lib/cn";
import { TagPill } from "./badge";

type Tab = {
  id: string;
  label: string;
  title: string;
  description: string;
  tags?: string[];
  media: React.ReactNode;
};

type TabbedShowcaseProps = {
  tabs: Tab[];
  className?: string;
};

/**
 * Cream feature showcase: a vertical tab rail on the left (active tab gets an
 * amber square + ink underline, inactive tabs read in muted ink) and an active
 * panel on the right with a serif title, Figtree body, and a dark inset media
 * card (e.g. a `CodeHighlight`/`MockupFrame`).
 */
export function TabbedShowcase({ tabs, className }: TabbedShowcaseProps) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  if (!active) return null;

  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-10 lg:grid-cols-[minmax(0,260px)_minmax(0,1fr)] lg:gap-14",
        className,
      )}
    >
      {/* Left vertical tab list */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Showcase"
        className="flex flex-col"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === active.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`panel-${tab.id}`}
              onClick={() => setActiveId(tab.id)}
              className={cn(
                "group relative flex items-center gap-3 border-b border-ink/12 py-4 text-left font-mono text-xs uppercase tracking-wide transition-colors outline-none focus-visible:text-ink",
                isActive ? "text-ink" : "text-ink/50 hover:text-ink/80",
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "h-[7px] w-[7px] shrink-0 rounded-[2px] transition-colors",
                  isActive ? "bg-glow" : "bg-ink/20",
                )}
              />
              <span>{tab.label}</span>
              {isActive ? (
                <motion.span
                  layoutId="tabbed-showcase-underline"
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-px h-px bg-ink"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Right active panel */}
      <div className="relative min-h-[20rem]">
        <AnimatePresence mode="wait">
          <motion.div
            key={active.id}
            role="tabpanel"
            id={`panel-${active.id}`}
            aria-labelledby={`tab-${active.id}`}
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
            className="flex flex-col gap-6"
          >
            <div className="max-w-xl">
              <h3 className="font-display text-2xl leading-[1.15] tracking-tight text-ink md:text-3xl">
                {active.title}
              </h3>
              <p className="mt-4 text-base text-ink/65 md:text-lg">
                {active.description}
              </p>
              {active.tags && active.tags.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {active.tags.map((tag) => (
                    <TagPill key={tag} tone="light">
                      {tag}
                    </TagPill>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="min-w-0">{active.media}</div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
