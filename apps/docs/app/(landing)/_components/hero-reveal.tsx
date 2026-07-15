"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

/**
 * The above-the-fold hero entrance: a staggered fade + lift + un-blur that
 * plays once on mount. Each direct child wrapped in <HeroItem> arrives in
 * sequence, so the badge → headline → subhead → prompt card → caption settle
 * in one smooth cascade instead of popping in together.
 *
 * Honors prefers-reduced-motion (renders the final state with no animation).
 */
const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.1, delayChildren: 0.06 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 20, filter: "blur(8px)" },
  show: {
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { duration: 0.7, ease: [0.16, 1, 0.3, 1] },
  },
};

export function HeroReveal({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      variants={container}
      initial={reduce ? false : "hidden"}
      animate="show"
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function HeroItem({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <motion.div
      variants={item}
      className={cn("flex flex-col items-center", className)}
    >
      {children}
    </motion.div>
  );
}
