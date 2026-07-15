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
 * viewport. Transform/opacity/blur only — GPU-light and respects reduced
 * motion (Motion reads the OS preference and falls back to the final state).
 *
 * The easeOutExpo curve + slight blur-in give a softer, more settled arrival
 * than a plain ease-out slide — this is the shared reveal for the whole site.
 */
export function Reveal({ children, delay = 0, className }: RevealProps) {
  return (
    <motion.div
      className={cn(className)}
      initial={{ opacity: 0, y: 20, filter: "blur(6px)" }}
      whileInView={{ opacity: 1, y: 0, filter: "blur(0px)" }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.7, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}
