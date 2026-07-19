"use client";

import { AnimatePresence, motion } from "motion/react";
import Image, { type StaticImageData } from "next/image";
import { useState } from "react";
import { TrackDemoClick } from "@/components/analytics/track";
import { cn } from "@/lib/cn";
import { DEMO_URL } from "@/lib/site";

/**
 * Studio screenshot gallery — the live-demo section's window. One main frame
 * in the browser chrome (still a link to the demo instance), with a thumbnail
 * rail below to flip between Studio views. Every shot is the real Studio on
 * the seeded Forgeline instance.
 */

export type StudioShot = {
  key: string;
  /** Thumbnail label + the path shown in the chrome bar. */
  label: string;
  path: string;
  alt: string;
  image: StaticImageData;
};

export function StudioGallery({ shots }: { shots: StudioShot[] }) {
  const [activeKey, setActiveKey] = useState(shots[0].key);
  const active = shots.find((s) => s.key === activeKey) ?? shots[0];

  return (
    <div className="mt-14">
      <div className="overflow-hidden rounded-xl border border-white/15 bg-[#0a0606] shadow-2xl">
        <div className="flex items-center justify-between border-white/10 border-b px-4 py-2.5">
          <div className="flex min-w-0 items-center gap-3">
            <div aria-hidden="true" className="flex items-center gap-1.5">
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
              <span className="size-2.5 rounded-full bg-white/15" />
            </div>
            <span className="min-w-0 truncate font-mono text-[11px] text-white/40 tracking-wide">
              demo.hogsend.com{active.path} — Forgeline
            </span>
          </div>
          <span className="flex shrink-0 items-center gap-1.5 font-mono text-[#23c489] text-[11px]">
            <span className="ps-pulse size-1.5 rounded-full bg-[#23c489]" />
            live
          </span>
        </div>

        <TrackDemoClick placement="home-demo-screenshot">
          <a
            href={DEMO_URL}
            target="_blank"
            rel="noreferrer"
            aria-label={`Open the live demo — showing ${active.label}`}
            className="block"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={active.key}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.22, ease: "easeOut" }}
              >
                <Image src={active.image} alt={active.alt} className="w-full" />
              </motion.div>
            </AnimatePresence>
          </a>
        </TrackDemoClick>
      </div>

      {/* Thumbnail rail — flip between Studio views. */}
      <div
        role="tablist"
        aria-label="Studio views"
        className="mt-4 flex gap-3 overflow-x-auto pb-2 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {shots.map((shot) => {
          const isActive = shot.key === activeKey;
          return (
            <button
              key={shot.key}
              type="button"
              role="tab"
              aria-selected={isActive}
              onClick={() => setActiveKey(shot.key)}
              className={cn(
                "group shrink-0 text-left outline-none",
                "w-[128px] sm:w-[148px]",
              )}
            >
              <span
                className={cn(
                  "block overflow-hidden rounded-md border transition-colors",
                  isActive
                    ? "border-[#f64838]/70"
                    : "border-white/10 group-hover:border-white/30",
                )}
              >
                <Image
                  src={shot.image}
                  alt=""
                  aria-hidden="true"
                  sizes="148px"
                  className={cn(
                    "w-full transition-opacity",
                    isActive
                      ? "opacity-100"
                      : "opacity-55 group-hover:opacity-85",
                  )}
                />
              </span>
              <span
                className={cn(
                  "mt-1.5 block truncate font-mono text-[10.5px] tracking-wide transition-colors",
                  isActive
                    ? "text-white/80"
                    : "text-white/40 group-hover:text-white/65",
                )}
              >
                {shot.label}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
