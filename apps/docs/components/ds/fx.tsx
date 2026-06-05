"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";

/* Amber glow (#FFA946 = rgb 255,169,70) — the warm spot color that replaces the
   retired green. Teal (#034F46 = rgb 3,79,70) is used for the cooler radial. */
const GLOW = "255, 169, 70";
const TEAL = "3, 79, 70";

type FxProps = { className?: string };

/**
 * GlowField — a warm, airy backdrop for the cream hero. Instead of the old
 * black field with green crystalline towers, this lays down two very soft amber
 * blooms drifting up from the lower corners plus a faint teal wash, all at low
 * opacity so it reads as a gentle glow ON the cream canvas (no dark fill, no
 * green). Transform/opacity-only animation; Motion honors reduced-motion.
 */
export function GlowField({ className }: FxProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
    >
      {/* Lower-left amber bloom */}
      <motion.div
        className="absolute -bottom-24 -left-16 h-[80%] w-[55%] origin-bottom-left will-change-transform"
        style={{
          filter: "blur(60px)",
          background: `radial-gradient(60% 70% at 25% 100%, rgba(${GLOW}, 0.22), transparent 70%)`,
        }}
        initial={{ opacity: 0.7, scale: 1 }}
        animate={{ opacity: [0.55, 0.8, 0.55], scale: [1, 1.05, 1] }}
        transition={{
          duration: 11,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* Lower-right amber bloom (offset cadence) */}
      <motion.div
        className="absolute -right-16 -bottom-24 h-[80%] w-[55%] origin-bottom-right will-change-transform"
        style={{
          filter: "blur(60px)",
          background: `radial-gradient(60% 70% at 75% 100%, rgba(${GLOW}, 0.18), transparent 70%)`,
        }}
        initial={{ opacity: 0.7, scale: 1 }}
        animate={{ opacity: [0.8, 0.55, 0.8], scale: [1.04, 1, 1.04] }}
        transition={{
          duration: 13,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* Faint cool teal wash up top to add depth without darkening the cream */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(90% 60% at 50% -10%, rgba(${TEAL}, 0.06), transparent 60%)`,
        }}
      />
    </div>
  );
}

/**
 * AuroraBeam — a soft diagonal amber light beam sweeping across a section:
 * blurred, low opacity, slow drift. Works on both the cream canvas and dark
 * rounded panels because it's just a translucent warm gradient. Pure gradient +
 * blur with a gentle translate/opacity loop (reduced-motion honored by Motion).
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
          background: `linear-gradient(115deg, transparent 30%, rgba(${GLOW}, 0.18) 48%, rgba(${GLOW}, 0.08) 56%, transparent 70%)`,
          filter: "blur(56px)",
          transform: "rotate(-8deg)",
        }}
        initial={{ x: "-8%", opacity: 0.6 }}
        animate={{ x: ["-8%", "8%", "-8%"], opacity: [0.45, 0.75, 0.45] }}
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
 * DotGrid — a sparse, fading dotted field for a CTA backdrop. Reimplemented as a
 * self-contained inline radial-dot pattern in amber (replacing the retired green
 * `.dot-grid` global), masked so the dots dissolve toward the edges.
 */
export function DotGrid({ className }: FxProps) {
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        backgroundImage: `radial-gradient(rgba(${GLOW}, 0.35) 1px, transparent 1px)`,
        backgroundSize: "22px 22px",
        maskImage:
          "radial-gradient(60% 60% at 50% 50%, #000 0%, transparent 75%)",
        WebkitMaskImage:
          "radial-gradient(60% 60% at 50% 50%, #000 0%, transparent 75%)",
      }}
    />
  );
}
