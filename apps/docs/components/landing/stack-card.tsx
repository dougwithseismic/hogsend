"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * One card in a scroll-stacking deck. The card scrolls normally until its
 * bottom reaches the viewport bottom, then pins so the next card slides up
 * over it — `top: min(0px, 100vh - height)` handles cards both shorter and
 * taller than the viewport. Siblings paint over earlier cards in DOM order
 * (positioned elements need no explicit z-index), so the parent just needs
 * `position: relative` to bound how long a covered card stays pinned.
 */
export function StackCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [top, setTop] = useState("0px");

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      setTop(`min(0px, calc(100vh - ${el.offsetHeight}px))`);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, []);

  return (
    <div
      ref={ref}
      style={{ top }}
      className={cn(
        "sticky overflow-hidden rounded-t-3xl border-t border-white/10",
        "bg-ink shadow-[0_-30px_60px_-20px_rgba(0,0,0,0.6)]",
        className,
      )}
    >
      {children}
    </div>
  );
}
