import type { JSX } from "react";
import { cn } from "@/lib/cn";

/**
 * ClipVideo — an embedded marketing clip (rendered from the real journey
 * code in marketing/video). The clip frames carry their own card chrome
 * and watermark, so this wraps them in just a hairline panel plus the
 * red atmospheric bloom the code windows use. Autoplays muted, loops.
 */
export function ClipVideo({
  clip,
  title,
  className,
}: {
  /** Clip id, e.g. "journey-onboarding" (resolved via /api/clips). */
  clip: string;
  title: string;
  className?: string;
}): JSX.Element {
  return (
    <div className={cn("relative", className)}>
      <div
        aria-hidden="true"
        className="-inset-x-10 -inset-y-6 pointer-events-none absolute"
        style={{
          background:
            "radial-gradient(60% 60% at 50% 65%, rgba(246, 72, 56, 0.14), transparent 70%)",
          filter: "blur(40px)",
        }}
      />
      <div className="relative overflow-hidden rounded-xl border border-white/10 bg-[#050101]">
        {/* biome-ignore lint/a11y/useMediaCaption: decorative product clip, no narration */}
        <video
          className="block w-full"
          src={`/api/clips/${clip}-169.mp4`}
          poster={`/api/clips/${clip}-poster.jpg`}
          autoPlay
          loop
          muted
          playsInline
          preload="metadata"
          aria-label={title}
        />
      </div>
    </div>
  );
}
