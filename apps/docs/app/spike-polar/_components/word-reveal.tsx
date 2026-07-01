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
 * Light-theme port of the homepage Manifesto word-reveal: words start as a
 * pale-gray ghost and resolve to ink as the block scrolls through the
 * viewport (per-word, scroll-linked opacity). Same mechanics, Polar palette.
 * Respects prefers-reduced-motion — words render fully ink.
 */

type WordProps = {
  progress: MotionValue<number>;
  range: [number, number];
  children: string;
};

function Word({ progress, range, children }: WordProps) {
  const opacity = useTransform(progress, range, [0, 1]);

  return (
    <span className="relative inline-block">
      {/* Static ghost so layout never shifts; the ink copy fades in over it. */}
      <span aria-hidden="true" className="text-[#d4d4db]">
        {children}
      </span>
      <motion.span
        style={{ opacity }}
        className="absolute inset-0 text-[#040406]"
      >
        {children}
      </motion.span>
    </span>
  );
}

export function WordReveal({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 0.85", "end 0.45"],
  });
  const words = text.split(" ");

  return (
    <span ref={ref} className={cn("inline", className)}>
      <span className="motion-reduce:hidden flex flex-wrap gap-x-[0.28em]">
        {words.map((word, index) => (
          <Word
            // biome-ignore lint/suspicious/noArrayIndexKey: static sentence, never reordered
            key={index}
            progress={scrollYProgress}
            range={[index / words.length, (index + 1) / words.length]}
          >
            {word}
          </Word>
        ))}
      </span>
      {/* Reduced-motion fallback: plain ink text. */}
      <span className="hidden text-[#040406] motion-reduce:inline">{text}</span>
    </span>
  );
}
