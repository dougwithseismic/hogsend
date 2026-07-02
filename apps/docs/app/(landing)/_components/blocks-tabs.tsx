"use client";

import { AnimatePresence, motion } from "motion/react";
import { type JSX, type ReactNode, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Light-chrome port of the homepage BuildingBlocks TabbedShowcase: a vertical
 * tab rail swaps title + description + tag pills + a dark code window. The
 * async CodeHighlight nodes are rendered in the page and passed in as
 * `media` (the RSC-composition pattern).
 */

export type BlockTab = {
  id: string;
  label: string;
  title: string;
  description: string;
  tags: string[];
  filename: string;
  media: ReactNode;
};

export function PsBlocksTabs({ tabs }: { tabs: BlockTab[] }): JSX.Element {
  const [activeId, setActiveId] = useState(tabs[0].id);
  const active = tabs.find((t) => t.id === activeId) ?? tabs[0];

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-[240px_1fr]">
      {/* Tab rail */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Building blocks"
        className="flex flex-row flex-wrap gap-1.5 lg:flex-col"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeId;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`ps-block-tab-${tab.id}`}
              aria-selected={isActive}
              aria-controls={`ps-block-panel-${tab.id}`}
              onClick={() => setActiveId(tab.id)}
              className={cn(
                "select-none rounded-[6px] border px-3.5 py-2 text-left font-medium text-sm tracking-[-0.025em] outline-none transition-colors duration-200",
                isActive
                  ? "border-[#f64838]/35 bg-[#f64838]/[0.08] text-white"
                  : "border-transparent text-white/55 hover:bg-white/[0.05] hover:text-white",
              )}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Panel */}
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={active.id}
          role="tabpanel"
          id={`ps-block-panel-${active.id}`}
          aria-labelledby={`ps-block-tab-${active.id}`}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.22, ease: "easeOut" }}
          className="min-w-0"
        >
          <h3 className="font-medium text-white text-xl tracking-[-0.02em]">
            {active.title}
          </h3>
          <p className="mt-2 max-w-[640px] text-white/55 text-sm leading-[21px] tracking-[-0.02em]">
            {active.description}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {active.tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-white/10 bg-white/[0.05] px-2.5 py-0.5 font-mono text-white/55 text-[11px]"
              >
                {tag}
              </span>
            ))}
          </div>

          {/* Dark code window with editor chrome. */}
          <div className="mt-5 overflow-hidden rounded-lg border border-[#1c1d22] bg-[#101014] shadow-xl">
            <div className="flex items-center gap-3 border-white/[0.08] border-b px-4 py-0">
              <div aria-hidden="true" className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
                <span className="size-2.5 rounded-full bg-white/15" />
              </div>
              <span className="border-[#f64838] border-b-2 py-2.5 font-mono text-[11px] text-white/75 tracking-wide">
                {active.filename}
              </span>
            </div>
            <div className="ps-code max-h-[420px] overflow-y-auto px-4 py-4">
              {active.media}
            </div>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
