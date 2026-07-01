"use client";

import { motion } from "motion/react";
import { cn } from "@/lib/cn";

/* Accent red (#F64838 = rgb 246,72,56) used throughout these layers. */
const ACCENT = "246, 72, 56";

type FxProps = { className?: string };

/**
 * GlowField — the hero backdrop: a giant glowing red planet-horizon arc
 * rising from below the fold (rim-lit circle over a near-black field) and a
 * dark landscape silhouette at the bottom. Built entirely from layered CSS
 * gradients, box-shadow rim light, and blur — recreated, never copied from
 * the reference assets.
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
      {/* Atmosphere bloom behind the horizon, with a slow breathing pulse. */}
      <motion.div
        className="absolute inset-0 will-change-transform"
        style={{
          background: `radial-gradient(85% 60% at 50% 80%, rgba(${ACCENT}, 0.3), rgba(${ACCENT}, 0.08) 45%, transparent 72%)`,
          filter: "blur(28px)",
        }}
        initial={{ opacity: 0.85 }}
        animate={{ opacity: [0.75, 1, 0.75] }}
        transition={{
          duration: 10,
          repeat: Number.POSITIVE_INFINITY,
          ease: "easeInOut",
        }}
      />

      {/* The planet: a giant circle below the fold — dark body, red rim light
          on its upper edge (ring mask via box-shadow + inset glow). */}
      <div
        className="-translate-x-1/2 absolute top-[58%] left-1/2 aspect-square w-[175%] rounded-full"
        style={{
          background: "#050101",
          boxShadow: [
            `0 -2px 18px rgba(${ACCENT}, 0.9)`,
            `0 -16px 70px rgba(${ACCENT}, 0.55)`,
            `0 -70px 200px rgba(${ACCENT}, 0.28)`,
            `inset 0 22px 70px rgba(${ACCENT}, 0.35)`,
          ].join(","),
        }}
      />

      {/* Dark landscape silhouette along the bottom edge. */}
      <div
        className="absolute inset-x-0 bottom-0 h-[28%]"
        style={{
          background:
            "linear-gradient(to top, #050101 35%, rgba(5, 1, 1, 0.8) 65%, transparent)",
        }}
      />
    </div>
  );
}

/**
 * AuroraBeam — a soft diagonal red light beam sweeping across a dark section:
 * blurred, low opacity, slow drift. Pure gradient + blur with a gentle
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
        className="-inset-x-1/4 -translate-y-1/2 absolute top-1/2 h-[140%] will-change-transform"
        style={{
          background: `linear-gradient(115deg, transparent 30%, rgba(${ACCENT}, 0.18) 48%, rgba(${ACCENT}, 0.08) 56%, transparent 70%)`,
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
 * DotGrid — scattered fading red-tinted dots for a CTA backdrop. Uses the
 * global `.dot-grid` pattern with a radial mask so the dots fade toward the
 * edges.
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
