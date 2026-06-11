"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";
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
 * Crimzon product showcase: a full-width tab row (labels spread edge-to-edge
 * inside the frame, hairline above + below, active label in red) over one
 * giant glass panel — the media floats in a dark glass card on a red
 * atmospheric backdrop.
 */
export function TabbedShowcase({ tabs, className }: TabbedShowcaseProps) {
  const [activeId, setActiveId] = useState(tabs[0]?.id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  if (!active) return null;

  return (
    <div className={cn("flex flex-col", className)}>
      {/* Full-width tab row */}
      <div
        role="tablist"
        aria-orientation="horizontal"
        aria-label="Showcase"
        className="flex w-full flex-wrap items-center justify-between gap-x-6 gap-y-1 border-hairline-faint border-y"
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
              onClick={() => {
                if (tab.id !== active.id) {
                  capture(AnalyticsEvent.TAB_SELECTED, { tab: tab.id });
                }
                setActiveId(tab.id);
              }}
              className={cn(
                "relative py-5 text-left text-base tracking-[-0.02em] outline-none transition-colors focus-visible:text-accent",
                isActive ? "text-accent" : "text-white hover:text-white/70",
              )}
            >
              {tab.label}
              {isActive ? (
                <motion.span
                  layoutId="tabbed-showcase-underline"
                  aria-hidden="true"
                  className="absolute inset-x-0 -bottom-px h-px bg-accent"
                />
              ) : null}
            </button>
          );
        })}
      </div>

      {/* Giant glass product panel */}
      <div className="relative mt-10 overflow-hidden rounded-xl border border-white/10 bg-[#0a0606]">
        {/* Red atmospheric backdrop — pure CSS, recreated (never copied). */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0"
          style={{
            background: [
              "radial-gradient(90% 70% at 50% 110%, rgba(246,72,56,0.3), rgba(246,72,56,0.08) 50%, transparent 75%)",
              "radial-gradient(50% 40% at 80% 0%, rgba(246,72,56,0.12), transparent 70%)",
            ].join(","),
            filter: "blur(20px)",
          }}
        />

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
            className="relative flex flex-col gap-8 p-6 md:p-10"
          >
            <div className="max-w-xl">
              <h3 className="font-medium font-sans text-white text-xl leading-[1.2] tracking-[-0.02em]">
                {active.title}
              </h3>
              <p className="mt-3 text-base text-white/60 leading-6">
                {active.description}
              </p>
              {active.tags && active.tags.length > 0 ? (
                <div className="mt-5 flex flex-wrap gap-2">
                  {active.tags.map((tag) => (
                    <TagPill key={tag}>{tag}</TagPill>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="glass-panel min-w-0 overflow-hidden">
              {active.media}
            </div>
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}
