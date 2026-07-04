"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * Floating course promo pointing at course.hogsend.com, on the crimzon ink
 * scheme (matches the hero's "Course" announcement pill).
 *
 * Responsive shape:
 * - Desktop (sm+): a floating bottom-right card, 330px wide.
 * - Mobile: a full-width bar pinned to the bottom edge. It is NOT sized with
 *   `100vw` (which includes the scrollbar gutter and overflowed the viewport,
 *   forcing a horizontal scroll that stretched the whole page) — it spans via
 *   `inset-x-0`, which is exactly the viewport width.
 *
 * Dismissible (persisted in localStorage) and hides itself as you scroll down,
 * returning when you scroll back up, so it never sits over the content you're
 * reading.
 */

const STORAGE_KEY = "hs-course-card-dismissed";
const COURSE_URL = "https://course.hogsend.com";

export function CourseCard() {
  // Start hidden so SSR + first client paint match (no flash before we've
  // read the dismissed flag).
  const [dismissed, setDismissed] = useState(true);
  const [shown, setShown] = useState(false);
  const [hiddenByScroll, setHiddenByScroll] = useState(false);

  useEffect(() => {
    if (localStorage.getItem(STORAGE_KEY) === "1") return;
    setDismissed(false);
    const t = setTimeout(() => setShown(true), 1200);
    return () => clearTimeout(t);
  }, []);

  // Hide on scroll-down, reveal on scroll-up (rAF-throttled). Near the very top
  // it always shows.
  useEffect(() => {
    if (dismissed) return;
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        const y = window.scrollY;
        const delta = y - lastY;
        if (Math.abs(delta) < 6) return; // ignore jitter
        setHiddenByScroll(delta > 0 && y > 80);
        lastY = y;
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [dismissed]);

  if (dismissed) return null;

  const dismiss = () => {
    setShown(false);
    try {
      localStorage.setItem(STORAGE_KEY, "1");
    } catch {
      // Private mode / storage disabled — dismiss for the session anyway.
    }
    setTimeout(() => setDismissed(true), 300);
  };

  const visible = shown && !hiddenByScroll;

  return (
    <div
      className={cn(
        "fixed bottom-0 inset-x-0 z-50 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[330px]",
        "transition-all duration-500 ease-out motion-reduce:transition-none",
        visible
          ? "translate-y-0 opacity-100"
          : "pointer-events-none translate-y-full opacity-0",
      )}
    >
      <Link
        href={COURSE_URL}
        className={cn(
          "group relative block overflow-hidden border-white/15 bg-[#0a0606] p-5 shadow-2xl transition-colors hover:border-white/25",
          // Mobile: full-width bar with only the top corners rounded and a top
          // hairline; extra bottom padding clears the iOS home indicator.
          "rounded-t-[14px] border-t pb-[calc(1.25rem+env(safe-area-inset-bottom))]",
          // Desktop: a fully-bordered rounded card.
          "sm:rounded-[10px] sm:border sm:pb-5",
        )}
      >
        {/* Crimzon corner glow — the ink-glow-panel idiom. */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute right-0 bottom-0 h-32 w-32 translate-x-6 translate-y-8"
          style={{
            background:
              "radial-gradient(circle, rgba(246,72,56,0.30), transparent 70%)",
          }}
        />

        <span className="relative inline-flex items-center gap-2 rounded-full bg-[#f64838] px-2.5 py-0.5 font-medium text-[12px] text-white">
          Course
        </span>

        <h3 className="relative mt-3.5 font-normal text-[20px] text-white leading-[1.15] tracking-[-0.02em] [font-family:var(--ps-display)]">
          Measure → Keep → Grow
        </h3>
        {/* Hidden on the mobile bar to keep it compact; shown in the desktop card. */}
        <p className="relative mt-1.5 hidden max-w-[260px] text-[13.5px] text-white/55 leading-[19px] tracking-[-0.02em] sm:block">
          How to be a modern growth practitioner — the PostHog + Hogsend course.
        </p>

        <div className="relative mt-4 flex items-center gap-3">
          <span className="inline-flex items-center gap-1.5 rounded-[6px] bg-white px-3.5 py-2 font-medium text-[#0a0a0a] text-[13px] tracking-[-0.02em] transition-colors group-hover:bg-white/90">
            Start the course
            <span
              aria-hidden="true"
              className="transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
          <span className="font-mono text-[11px] text-white/40 tracking-[-0.01em]">
            course.hogsend.com
          </span>
        </div>
      </Link>

      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss course promo"
        className="absolute top-2.5 right-2.5 z-10 inline-flex size-6 items-center justify-center rounded-full text-white/40 transition-colors hover:bg-white/[0.08] hover:text-white"
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 12 12"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <path d="M2.5 2.5l7 7M9.5 2.5l-7 7" />
        </svg>
      </button>
    </div>
  );
}
