"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";

/* Accent green (#9FF690 = rgb 159,246,144) used throughout these layers. */
const ACCENT = "159, 246, 144";
const DEEP = "61, 142, 47";

type FxProps = { className?: string };

/**
 * GlowField — the hero backdrop. Luminous green crystalline "towers" rising
 * from the lower-left and lower-right edges of a black field, dark in the
 * center. Built entirely from stacked CSS gradients + blur with a slow
 * opacity/scale pulse (transform/opacity only). Recreates the proprietary
 * Framer render without copying any asset.
 */
export function GlowField({ className }: FxProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden bg-ink",
        className,
      )}
    >
      {/* Base vignette so the center reads dark and edges glow. */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(120% 90% at 50% 110%, rgba(${ACCENT}, 0.10), transparent 60%)`,
        }}
      />

      {/* Lower-left tower cluster: stacked angled gradients + radial bloom. */}
      <motion.div
        className="absolute -bottom-24 -left-16 h-[90%] w-[55%] origin-bottom-left will-change-transform"
        style={{
          filter: "blur(26px)",
          background: [
            // crystalline block faces (sharp-ish linear bands)
            `linear-gradient(72deg, rgba(${ACCENT}, 0.55) 0%, rgba(${DEEP}, 0.12) 38%, transparent 60%)`,
            `linear-gradient(108deg, rgba(${ACCENT}, 0.30) 0%, transparent 45%)`,
            // soft tower bloom anchored to the bottom edge
            `radial-gradient(70% 80% at 18% 100%, rgba(${ACCENT}, 0.45), transparent 70%)`,
          ].join(","),
        }}
        initial={{ opacity: 0.85, scale: 1 }}
        animate={{ opacity: [0.7, 1, 0.7], scale: [1, 1.04, 1] }}
        transition={{
          duration: 9,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* Lower-right tower cluster (mirror, slightly offset cadence). */}
      <motion.div
        className="absolute -bottom-24 -right-16 h-[90%] w-[55%] origin-bottom-right will-change-transform"
        style={{
          filter: "blur(26px)",
          background: [
            `linear-gradient(-72deg, rgba(${ACCENT}, 0.55) 0%, rgba(${DEEP}, 0.12) 38%, transparent 60%)`,
            `linear-gradient(-108deg, rgba(${ACCENT}, 0.30) 0%, transparent 45%)`,
            `radial-gradient(70% 80% at 82% 100%, rgba(${ACCENT}, 0.45), transparent 70%)`,
          ].join(","),
        }}
        initial={{ opacity: 0.85, scale: 1 }}
        animate={{ opacity: [1, 0.7, 1], scale: [1.03, 1, 1.03] }}
        transition={{
          duration: 11,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* Sharper highlight slivers to suggest faceted block edges + perspective. */}
      <div
        className="absolute bottom-0 left-[8%] h-[62%] w-px opacity-50"
        style={{
          background: `linear-gradient(to top, rgba(${ACCENT}, 0.8), transparent)`,
          filter: "blur(1px)",
          transform: "skewX(-8deg)",
        }}
      />
      <div
        className="absolute bottom-0 left-[18%] h-[48%] w-px opacity-40"
        style={{
          background: `linear-gradient(to top, rgba(${ACCENT}, 0.7), transparent)`,
          filter: "blur(1px)",
          transform: "skewX(-6deg)",
        }}
      />
      <div
        className="absolute bottom-0 right-[8%] h-[62%] w-px opacity-50"
        style={{
          background: `linear-gradient(to top, rgba(${ACCENT}, 0.8), transparent)`,
          filter: "blur(1px)",
          transform: "skewX(8deg)",
        }}
      />
      <div
        className="absolute bottom-0 right-[18%] h-[48%] w-px opacity-40"
        style={{
          background: `linear-gradient(to top, rgba(${ACCENT}, 0.7), transparent)`,
          filter: "blur(1px)",
          transform: "skewX(6deg)",
        }}
      />

      {/* Keep the center deep-black so content stays legible. */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(55% 55% at 50% 45%, #000 0%, rgba(0,0,0,0.7) 45%, transparent 75%)`,
        }}
      />
    </div>
  );
}

/**
 * AuroraBeam — a soft diagonal green light beam sweeping across a dark
 * section: blurred, low opacity, slow drift. Pure gradient + blur with a gentle
 * translate/opacity loop.
 */
export function AuroraBeam({ className }: FxProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      <motion.div
        className="absolute -inset-x-1/4 top-1/2 h-[140%] -translate-y-1/2 will-change-transform"
        style={{
          background: `linear-gradient(115deg, transparent 30%, rgba(${ACCENT}, 0.22) 48%, rgba(${ACCENT}, 0.10) 56%, transparent 70%)`,
          filter: "blur(48px)",
          transform: "rotate(-8deg)",
        }}
        initial={{ x: "-8%", opacity: 0.7 }}
        animate={{ x: ["-8%", "8%", "-8%"], opacity: [0.55, 0.9, 0.55] }}
        transition={{
          duration: 16,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />
    </div>
  );
}

/**
 * DotGrid — scattered fading green dots for a CTA backdrop. Uses the global
 * `.dot-grid` pattern with a radial mask so the dots fade out toward the edges.
 */
export function DotGrid({ className }: FxProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("dot-grid pointer-events-none absolute inset-0", className)}
      style={{
        maskImage:
          "radial-gradient(60% 60% at 50% 50%, #000 0%, transparent 75%)",
        WebkitMaskImage:
          "radial-gradient(60% 60% at 50% 50%, #000 0%, transparent 75%)",
      }}
    />
  );
}
