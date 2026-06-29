"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";

type RevealProps = {
  children: React.ReactNode;
  /** Stagger delay in seconds before the reveal plays. */
  delay?: number;
  className?: string;
};

/**
 * Scroll-triggered fade + slide-in wrapper. Plays once when it enters the
 * viewport. Transform/opacity only — GPU-light and respects reduced motion
 * (Motion reads the OS preference and falls back to the final state).
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.5, delay, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
