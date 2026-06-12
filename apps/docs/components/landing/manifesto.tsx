"use client";

import {
  type MotionValue,
  motion,
  useScroll,
  useTransform,
} from "motion/react";
import { useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Manifesto — the crimzon word-reveal statement: a red kicker over one
 * centered 40/48 display sentence whose words start at white/20 and turn
 * white as the section scrolls through the viewport (per-word, scroll-linked
 * opacity). Carries the silent-churn narrative: signups leave because no
 * email ever asked them back, the fix has sat on the backlog for months,
 * and Hogsend ships it in an afternoon.
 *
 * Client island: motion's useScroll/useTransform need the browser. Respects
 * prefers-reduced-motion via the media query — words render fully white.
 */

const STATEMENT =
  "PostHog is incredible at showing you where users drop off. Acting on it " +
  "— the welcome, the nudge, the win-back — has meant buying a second " +
  "platform and syncing your data into it. Hogsend is that layer as code: " +
  "TypeScript journeys in your repo, triggered by the events you already " +
  "have.";

const WORDS = STATEMENT.split(" ");

type WordProps = {
  progress: MotionValue<number>;
  range: [number, number];
  children: string;
};

function Word({ progress, range, children }: WordProps) {
  const opacity = useTransform(progress, range, [0.2, 1]);

  return (
    <span className="relative inline-block">
      {/* Static ghost so layout never shifts; the bright copy fades in over it. */}
      <span aria-hidden="true" className="text-white/20">
        {children}
      </span>
      <motion.span style={{ opacity }} className="absolute inset-0 text-white">
        {children}
      </motion.span>
    </span>
  );
}

export function Manifesto({ className }: { className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.45"],
  });

  return (
    <section
      className={cn(
        "relative border-hairline-faint border-t text-white",
        className,
      )}
    >
      <div
        ref={ref}
        className="container-page section-py flex flex-col items-center text-center"
      >
        <span className="kicker">The problem</span>

        <p className="motion-reduce:hidden mt-8 flex max-w-[900px] flex-wrap justify-center gap-x-[0.3em] gap-y-1 font-display text-[28px] leading-[1.25] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
          {WORDS.map((word, index) => (
            <Word
              // biome-ignore lint/suspicious/noArrayIndexKey: static sentence, never reordered
              key={index}
              progress={scrollYProgress}
              range={[index / WORDS.length, (index + 1) / WORDS.length]}
            >
              {word}
            </Word>
          ))}
        </p>

        {/* Reduced-motion fallback: the same statement, fully legible. */}
        <p className="motion-reduce:block hidden mt-8 max-w-[900px] font-display text-[28px] text-white leading-[1.25] tracking-[-0.02em] md:text-[40px] md:leading-[48px]">
          {STATEMENT}
        </p>
      </div>
    </section>
  );
}
