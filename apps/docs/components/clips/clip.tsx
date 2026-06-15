"use client";

import type { JSX } from "react";
import { cn } from "@/lib/cn";
import { ByoProvider } from "./byo-provider";
import { CLIP_SPECS } from "./clip-specs";
import { FirstPartyTracking } from "./first-party-tracking";
import { JourneyTrace } from "./journey-trace";
import { ScaffoldDemo } from "./scaffold-demo";
import { SemanticLinks } from "./semantic-links";

/**
 * Clip — resolves a clip id to its native React port (the marketing clips,
 * ported to a looping web frame clock) instead of streaming an mp4 from a
 * bucket:
 *   - "first-party-tracking" → the first-party tracking comp
 *   - "semantic-links"       → the semantic links comp
 *   - "scaffold-demo"        → the scaffold demo comp
 *   - "byo-provider"         → the BYO email provider comp
 *   - any CLIP_SPECS[clip]   → the JourneyTrace engine for that spec
 *   - otherwise              → null
 */
export function Clip({
  clip,
  title,
  className,
}: {
  /** Clip id, e.g. "journey-onboarding" or "first-party-tracking". */
  clip: string;
  title: string;
  className?: string;
}): JSX.Element | null {
  const body =
    clip === "first-party-tracking" ? (
      <FirstPartyTracking />
    ) : clip === "semantic-links" ? (
      <SemanticLinks />
    ) : clip === "scaffold-demo" ? (
      <ScaffoldDemo />
    ) : clip === "byo-provider" ? (
      <ByoProvider />
    ) : CLIP_SPECS[clip] ? (
      <JourneyTrace spec={CLIP_SPECS[clip]} />
    ) : null;

  if (!body) {
    return null;
  }

  return (
    <div className={cn(className)} role="img" aria-label={title}>
      {body}
    </div>
  );
}
