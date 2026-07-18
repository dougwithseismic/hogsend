"use client";

import { useEffect, useState } from "react";

/** Full-height vertical hairlines at the content-frame edges — the crimzon
 * PageFrame idiom, re-keyed to a light red-tint rule. The rails are dropped
 * over the hero (they clash with the full-bleed day-field vista) and fade in
 * once it scrolls out of view. */
export function PsFrame() {
  const [pastHero, setPastHero] = useState(false);

  useEffect(() => {
    const sync = () => setPastHero(window.scrollY > window.innerHeight * 0.8);
    sync();
    window.addEventListener("scroll", sync, { passive: true });
    return () => window.removeEventListener("scroll", sync);
  }, []);

  return (
    <div
      aria-hidden="true"
      className={`-translate-x-1/2 pointer-events-none fixed inset-y-0 left-1/2 z-40 hidden w-full max-w-[1256px] border-[#f6483826] border-x transition-opacity duration-500 lg:block ${
        pastHero ? "opacity-100" : "opacity-0"
      }`}
    />
  );
}
