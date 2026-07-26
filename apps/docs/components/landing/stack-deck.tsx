"use client";

import { Children, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A scroll-stacking deck. Each child becomes a card that scrolls normally
 * until its bottom reaches the viewport bottom, then pins so the next card
 * slides up over it — `top: min(0px, 100vh - height)` handles cards both
 * shorter and taller than the viewport. As the next card covers a pinned one,
 * the covered card recedes: it scales down toward its pinned bottom edge,
 * slips upward, and a veil dims it under the incoming card. All effects are
 * transform/opacity only, driven by one rAF-throttled scroll handler, and
 * skipped entirely under prefers-reduced-motion (plain pin-and-cover remains).
 *
 * Positioned siblings paint over earlier ones in DOM order, so no z-index
 * bookkeeping is needed; the deck wrapper is `relative` to bound how long a
 * covered card stays pinned.
 */
export function StackDeck({
  children,
  labels,
  className,
}: {
  children: ReactNode;
  /** Optional per-card labels for the corner counter chip ("01 / 08 — Video"). */
  labels?: string[];
  className?: string;
}) {
  const deckRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const cards = Array.from(
      deck.querySelectorAll<HTMLElement>("[data-stack-card]"),
    );
    if (cards.length === 0) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let raf = 0;

    // The pin point: bottom edge at the viewport bottom, whatever the height.
    const updateTops = () => {
      for (const card of cards) {
        card.style.top = `min(0px, calc(100vh - ${card.offsetHeight}px))`;
      }
    };

    // Recede each covered card in proportion to how far the next card has
    // risen over it (0 = untouched, 1 = fully covered).
    const update = () => {
      raf = 0;
      if (reducedMotion) return;
      const vh = window.innerHeight;
      for (let i = 0; i < cards.length; i++) {
        const inner = cards[i].querySelector<HTMLElement>("[data-stack-inner]");
        const veil = cards[i].querySelector<HTMLElement>("[data-stack-veil]");
        if (!inner || !veil) continue;
        const next = cards[i + 1];
        const progress = next
          ? Math.min(
              1,
              Math.max(0, (vh - next.getBoundingClientRect().top) / vh),
            )
          : 0;
        inner.style.transform = `translateY(${(progress * -28).toFixed(1)}px) scale(${(1 - progress * 0.045).toFixed(4)})`;
        veil.style.opacity = (progress * 0.6).toFixed(3);
      }
    };

    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(update);
    };
    const onResize = () => {
      updateTops();
      schedule();
    };

    updateTops();
    update();
    const observer = new ResizeObserver(onResize);
    for (const card of cards) observer.observe(card);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", onResize);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      observer.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  const items = Children.toArray(children);
  const total = String(items.length).padStart(2, "0");

  return (
    <div ref={deckRef} className={cn("relative", className)}>
      {items.map((child, index) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: static section order, never reordered
          key={index}
          data-stack-card
          className="sticky overflow-hidden rounded-t-3xl border-t border-white/10 bg-ink shadow-[0_-40px_80px_-24px_rgba(0,0,0,0.8)]"
        >
          {/* Leading-edge hairline glow — sells the card seam as it slides over. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
          />
          <div
            data-stack-inner
            style={{ transformOrigin: "50% 100%", willChange: "transform" }}
          >
            {labels?.[index] ? (
              <div className="pointer-events-none absolute top-6 right-6 z-10 hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[11px] text-white/40 uppercase tracking-[0.12em] md:flex">
                <span className="text-white/60">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>/ {total}</span>
                <span aria-hidden="true">—</span>
                <span>{labels[index]}</span>
              </div>
            ) : null}
            {child}
          </div>
          {/* Dimming veil — the covered card falls into shadow as the next
              card rises over it. Sits above the content by paint order. */}
          <div
            data-stack-veil
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 bg-ink opacity-0"
          />
        </div>
      ))}
    </div>
  );
}
