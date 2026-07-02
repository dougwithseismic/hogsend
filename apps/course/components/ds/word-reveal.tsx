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
 * Word-by-word scroll fade (the crimzon manifesto treatment): each word
 * starts as a white/20 ghost and resolves to white as the block scrolls
 * through the viewport (per-word, scroll-linked opacity). Typography comes
 * from the parent — pass font/size/leading via className.
 *
 * Client island: motion's useScroll/useTransform need the browser. Respects
 * prefers-reduced-motion — the plain sentence renders fully white.
 */

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
      {/* Reduced-motion fallback: the same sentence, fully legible. */}
      <span className="hidden text-white motion-reduce:inline">{text}</span>
    </span>
  );
}
