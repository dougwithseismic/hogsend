"use client";

import { Children, type ReactNode, useEffect, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * A scroll-stacking deck. Each child becomes a card that scrolls normally
 * until its bottom reaches the viewport bottom, then pins so the next card
 * slides up over it — `top: min(0px, 100vh - height)` handles cards both
 * shorter and taller than the viewport. As the next card covers a pinned one,
 * the covered card recedes: it scales down toward its pinned bottom edge,
 * slips upward, and a veil dims it under the incoming card. Once a card is
 * buried under the next one it is un-pinned, so only the cards in play stay
 * stuck to the viewport however deep the deck runs. All effects are
 * transform/opacity only, driven by one rAF-throttled scroll handler, and
 * skipped under prefers-reduced-motion (plain pin-and-cover remains).
 *
 * Positioned siblings paint over earlier ones in DOM order, so no z-index
 * bookkeeping is needed; the deck wrapper is `relative` to bound how long a
 * covered card stays pinned.
 */
export type StackDeckCard = {
  /** Label for the corner counter chip ("01 / 08 — Video"). */
  label: string;
  /** Section id the chip links to (rendered as `#anchor`). */
  anchor?: string;
};

export function StackDeck({
  children,
  cards,
  className,
}: {
  children: ReactNode;
  /** Optional per-card chip config, index-matched to children. */
  cards?: StackDeckCard[];
  className?: string;
}) {
  const deckRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const deck = deckRef.current;
    if (!deck) return;
    const cards = Array.from(
      deck.querySelectorAll<HTMLElement>("[data-stack-card]"),
      (el) => ({
        el,
        inner: el.querySelector<HTMLElement>("[data-stack-inner]"),
        veil: el.querySelector<HTMLElement>("[data-stack-veil]"),
        height: el.offsetHeight,
        pinTop: "",
        buried: false,
        transform: "",
        veilOpacity: "0",
      }),
    );
    if (cards.length === 0) return;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    let raf = 0;

    // The pin point: bottom edge at the viewport bottom, whatever the height.
    const updateTops = () => {
      for (const card of cards) {
        card.height = card.el.offsetHeight;
        card.pinTop = `min(0px, calc(100vh - ${card.height}px))`;
        if (!card.buried) card.el.style.top = card.pinTop;
      }
    };

    const update = () => {
      raf = 0;
      const vh = window.innerHeight;

      // Read every geometry value before writing any style, so the writes
      // below never force a synchronous layout partway through the loop.
      // Flow tops are summed from heights: a sticky card's offsetTop reports
      // its stuck position, not where it sits in the flow.
      const deckTop = deck.getBoundingClientRect().top;
      const flowTops: number[] = [];
      let flowTop = deckTop;
      for (const card of cards) {
        flowTops.push(flowTop);
        flowTop += card.height;
      }
      const liveTops = cards.map((card) => card.el.getBoundingClientRect().top);

      for (let i = 0; i < cards.length; i++) {
        const card = cards[i];
        const hasNext = i + 1 < cards.length;

        // Un-pin a card once it is buried: the next card has covered it
        // completely (its flow top passed the viewport top) and scrolled a
        // further viewport on. Left pinned, every covered card stays stuck to
        // the viewport underneath the visible one, so by the end of the deck
        // the browser composites the whole stack on every frame and scrolling
        // falls apart. Back in the flow it sits wholly above the viewport, so
        // nothing visibly changes; the spare viewport means a fast scroll back
        // up re-pins it while it is still hidden, before it can show a gap.
        const buried = hasNext && flowTops[i + 1] <= -vh;
        if (buried !== card.buried) {
          card.buried = buried;
          card.el.style.position = buried ? "relative" : "";
          card.el.style.top = buried ? "" : card.pinTop;
        }

        // Recede a covered card in proportion to how far the next card has
        // risen over it (0 = untouched, 1 = fully covered).
        const progress =
          hasNext && !buried && !reducedMotion
            ? Math.min(1, Math.max(0, (vh - liveTops[i + 1]) / vh))
            : 0;
        // Clear the transform entirely at rest (and once buried) so those
        // cards are not promoted to their own huge compositor layers —
        // permanent layers this size cause ghost-frame glitches.
        const transform =
          progress > 0
            ? `translateY(${(progress * -28).toFixed(1)}px) scale(${(1 - progress * 0.045).toFixed(4)})`
            : "";
        const veilOpacity = progress > 0 ? (progress * 0.6).toFixed(3) : "0";
        if (card.inner && transform !== card.transform) {
          card.inner.style.transform = transform;
          card.transform = transform;
        }
        if (card.veil && veilOpacity !== card.veilOpacity) {
          card.veil.style.opacity = veilOpacity;
          card.veilOpacity = veilOpacity;
        }
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
    for (const card of cards) observer.observe(card.el);
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
          // min-h-screen: a card shorter than the viewport would otherwise
          // leave a gap below its bottom edge where the previous pinned card
          // shows through. Every card fills the viewport it covers; short
          // content centers vertically in the ink.
          // isolate: each card is its own stacking context so no z-indexed
          // element inside a section can paint across card boundaries. The
          // inline background doubles the bg-ink utility so the card stays
          // opaque even if the token ever fails to resolve.
          className="sticky isolate flex min-h-screen flex-col overflow-hidden rounded-t-3xl border-t border-white/10 bg-ink shadow-[0_-40px_80px_-24px_rgba(0,0,0,0.8)]"
          style={{ backgroundColor: "#050101" }}
        >
          {/* Leading-edge hairline glow — sells the card seam as it slides over. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 z-20 h-px bg-gradient-to-r from-transparent via-white/25 to-transparent"
          />
          <div
            data-stack-inner
            className="flex w-full grow flex-col justify-center"
            style={{ transformOrigin: "50% 100%" }}
          >
            {cards?.[index] ? (
              <a
                href={
                  cards[index].anchor ? `#${cards[index].anchor}` : undefined
                }
                className="absolute top-6 right-6 z-10 hidden items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 font-mono text-[11px] text-white/40 uppercase tracking-[0.12em] transition-colors hover:border-white/25 hover:text-white/80 md:flex"
              >
                <span className="text-white/60">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>/ {total}</span>
                <span aria-hidden="true">—</span>
                <span>{cards[index].label}</span>
              </a>
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
