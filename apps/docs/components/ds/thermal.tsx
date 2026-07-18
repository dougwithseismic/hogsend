"use client";

import { type CSSProperties, type ReactNode, useCallback, useRef } from "react";
import { cn } from "@/lib/cn";

/**
 * Thermal texture layers — generated crimzon "heat" imagery blended over the
 * near-black surfaces. Two sister images crossfade on a slow loop (reads as
 * the texture morphing); a mouse-following radial mask lifts the texture
 * where the cursor is, so it kisses the hairline borders instead of washing
 * the whole card.
 */

const TEXTURES = [
  "/images/textures/thermal-1.webp",
  "/images/textures/thermal-2.webp",
];

/** Cool end of the spectrum — violet/indigo with crimson embers. */
export const THERMAL_COOL = "/images/textures/thermal-cool.webp";

type ThermalLayerProps = {
  className?: string;
  /** 0–1 resting opacity of the texture. Keep low — subtlety is the point. */
  strength?: number;
  /** Blend mode against the surface underneath. */
  blend?: CSSProperties["mixBlendMode"];
  /** Texture pair to crossfade; warm sisters by default. A warm/cool pair
   *  reads as the field heating and cooling. */
  textures?: [string, string];
};

/**
 * The always-on texture bed: both sister images stacked with a slow
 * counter-phased opacity loop, blended with `screen` so black stays black.
 */
export function ThermalLayer({
  className,
  strength = 0.35,
  blend = "plus-lighter",
  textures = TEXTURES as [string, string],
}: ThermalLayerProps) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        "pointer-events-none absolute inset-0 overflow-hidden",
        className,
      )}
      style={{ opacity: strength }}
    >
      {textures.map((src, i) => (
        <div
          key={src}
          className="thermal-morph absolute inset-[-6%] bg-center bg-cover"
          style={{
            backgroundImage: `url(${src})`,
            mixBlendMode: blend,
            animationDelay: i === 0 ? "0s" : "-9s",
            animationDirection: i === 0 ? "normal" : "reverse",
          }}
        />
      ))}
    </div>
  );
}

/**
 * Code-drawn halftone dot screen, masked so it only shows where the texture
 * glows (crisp print texture riding on the soft blobs).
 *
 * Defaults reproduce the thermal-hero look (masked by the smoke texture,
 * `overlay` blend). Pass a custom `mask` — e.g. a radial concentrated on a
 * scene's light source — plus a gentler `blend` to ride a photographic backdrop
 * like the day-field vista instead of the generated smoke.
 */
export function HalftoneOverlay({
  className,
  mask,
  blend = "overlay",
  size = 7,
}: {
  className?: string;
  /** Override the mask (defaults to the thermal smoke texture). */
  mask?: string;
  /** Blend mode against the surface underneath. */
  blend?: CSSProperties["mixBlendMode"];
  /** Dot pitch in px. */
  size?: number;
}) {
  const textureMask = `url(${TEXTURES[0]})`;
  return (
    <div
      aria-hidden="true"
      className={cn("pointer-events-none absolute inset-0", className)}
      style={{
        mixBlendMode: blend,
        backgroundImage:
          "radial-gradient(circle at center, rgba(255,255,255,0.5) 1px, transparent 1px)",
        backgroundSize: `${size}px ${size}px`,
        maskImage: mask ?? textureMask,
        WebkitMaskImage: mask ?? textureMask,
        maskSize: mask ? undefined : "cover",
        maskPosition: mask ? undefined : "center",
        opacity: 0.5,
      }}
    />
  );
}

type ThermalHoverProps = {
  children: ReactNode;
  className?: string;
  /** Rounding of the kiss ring — match the wrapped element. */
  rounded?: string;
  /**
   * Kiss intensity. `soft` (default) is the featherweight ring tuned for the
   * near-black classic hero. `bold` is a warmer, brighter, wider sun-kiss that
   * survives a bright photographic backdrop like the day-field vista.
   */
  intensity?: "soft" | "bold";
};

/**
 * Featherweight cursor kiss for small inline UI (command chips, prompt
 * cards): no texture, just the white-hot hairline + bloom near the pointer.
 * Wrap the target; the ring hugs this wrapper's bounds.
 */
export function ThermalHover({
  children,
  className,
  rounded = "rounded-[6px]",
  intensity = "soft",
}: ThermalHoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", `${e.clientX - r.left}px`);
    el.style.setProperty("--hy", `${e.clientY - r.top}px`);
    el.style.setProperty("--ho", "1");
  }, []);

  const onLeave = useCallback(() => {
    ref.current?.style.setProperty("--ho", "0");
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mousemove only drives a decorative glow; no action is triggered.
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn("relative", className)}
      style={{ "--hx": "50%", "--hy": "50%", "--ho": "0" } as CSSProperties}
    >
      {children}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-0 transition-opacity duration-300",
          rounded,
        )}
        style={
          intensity === "bold"
            ? {
                opacity: "calc(var(--ho) * 0.7)",
                border: "1px solid rgba(255, 224, 178, 0.78)",
                boxShadow: [
                  "inset 0 0 12px -5px rgba(255, 190, 120, 0.72)",
                  "0 0 18px -5px rgba(246, 120, 56, 0.65)",
                ].join(","),
                maskImage:
                  "radial-gradient(150px circle at var(--hx) var(--hy), black, transparent 72%)",
              }
            : {
                opacity: "calc(var(--ho) * 0.6)",
                border: "1px solid rgba(255, 210, 160, 0.7)",
                boxShadow: [
                  "inset 0 0 10px -6px rgba(255, 176, 92, 0.7)",
                  "0 0 12px -5px rgba(246, 72, 56, 0.7)",
                ].join(","),
                maskImage:
                  "radial-gradient(110px circle at var(--hx) var(--hy), black, transparent 70%)",
              }
        }
      />
    </div>
  );
}

type ThermalCardProps = {
  children: ReactNode;
  className?: string;
  /** Resting texture strength; the mouse mask lifts it locally. */
  strength?: number;
};

/**
 * Card surface with the thermal bed + a cursor-following reveal. The reveal
 * is a radial mask driven by CSS vars (no re-render per mousemove), and an
 * extra border-glow layer so the heat visibly kisses the hairline frame.
 */
export function ThermalCard({
  children,
  className,
  strength = 0.1,
}: ThermalCardProps) {
  const ref = useRef<HTMLDivElement>(null);

  const onMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", `${e.clientX - r.left}px`);
    el.style.setProperty("--hy", `${e.clientY - r.top}px`);
    el.style.setProperty("--ho", "1");
  }, []);

  const onLeave = useCallback(() => {
    ref.current?.style.setProperty("--ho", "0");
  }, []);

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: mousemove only drives a decorative glow; no action is triggered.
    <div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      className={cn(
        "group relative overflow-hidden rounded-md border border-white/[0.08]",
        "bg-white/[0.015] p-6 text-white transition-colors duration-200",
        "hover:border-white/15",
        className,
      )}
      style={{ "--hx": "50%", "--hy": "50%", "--ho": "0" } as CSSProperties}
    >
      {/* Iron-bow edge ramp — thermal-camera falloff from the frame inward:
          hot amber at the hairline, red, then a wide violet bloom into black. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-md"
        style={{
          opacity: strength * 1.4,
          boxShadow: [
            "inset 0 0 10px -6px rgba(255, 176, 92, 0.9)",
            "inset 0 0 26px -10px rgba(246, 72, 56, 0.6)",
            "inset 0 0 64px -18px rgba(124, 58, 237, 0.45)",
          ].join(","),
        }}
      />

      {/* Resting texture, pushed to the frame: an inverted radial mask keeps
          the center clean and lets the heat pool along the edges as a glow. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0"
        style={{
          opacity: Math.min(strength * 2, 1),
          maskImage:
            "radial-gradient(105% 115% at 50% 50%, transparent 68%, black 98%)",
        }}
      >
        <ThermalLayer strength={1} />
      </div>

      {/* Cursor reveal: edge-masked too, so hovering warms the rim near the
          pointer rather than washing the card body. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 transition-opacity duration-300"
        style={{
          opacity: "calc(var(--ho) * 0.5)",
          maskImage:
            "radial-gradient(220px circle at var(--hx) var(--hy), black, transparent 72%)",
        }}
      >
        <div
          className="absolute inset-0"
          style={{
            maskImage:
              "radial-gradient(105% 115% at 50% 50%, transparent 62%, black 96%)",
          }}
        >
          <div
            className="absolute inset-[-6%] bg-center bg-cover mix-blend-plus-lighter"
            style={{ backgroundImage: `url(${TEXTURES[1]})` }}
          />
        </div>
      </div>

      {/* Border kiss: near the cursor the hairline goes white-hot with an
          orange bloom behind it — the hottest point on the thermal ramp. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 rounded-md transition-opacity duration-300"
        style={{
          opacity: "calc(var(--ho) * 0.95)",
          border: "1px solid rgba(255, 224, 178, 0.9)",
          boxShadow: [
            "inset 0 0 12px -6px rgba(255, 176, 92, 0.9)",
            "0 0 14px -4px rgba(246, 72, 56, 0.8)",
          ].join(","),
          maskImage:
            "radial-gradient(150px circle at var(--hx) var(--hy), black, transparent 68%)",
        }}
      />

      <div className="relative">{children}</div>
    </div>
  );
}
