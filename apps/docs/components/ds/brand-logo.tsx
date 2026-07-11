import { cn } from "@/lib/cn";

/**
 * Brand marks live in `public/images/logos/` as single-color SVGs. Rather than
 * render them as `<img>` (which can't inherit our text color), we paint each
 * one with a CSS mask: the SVG's alpha becomes the stencil and the element's
 * `currentColor` becomes the ink. That lets every logo take the same
 * white/opacity treatment as the surrounding type, on any background.
 */

export type BrandKey =
  | "posthog"
  | "resend"
  | "stripe"
  | "railway"
  | "typescript"
  | "hatchet"
  | "segment"
  | "slack"
  | "twilio";

// Intrinsic aspect ratio (width / height) per logo, from each SVG's viewBox.
// The integration marks are square; Hatchet ships as a 137×24 wordmark.
const ASPECT: Record<BrandKey, number> = {
  posthog: 1,
  resend: 1,
  stripe: 1,
  railway: 1,
  typescript: 1,
  hatchet: 137 / 24,
  segment: 1,
  slack: 1,
  twilio: 1,
};

const LABEL: Record<BrandKey, string> = {
  posthog: "PostHog",
  resend: "Resend",
  stripe: "Stripe",
  railway: "Railway",
  typescript: "TypeScript",
  hatchet: "Hatchet",
  segment: "Segment",
  slack: "Slack",
  twilio: "Twilio",
};

type BrandLogoProps = {
  brand: BrandKey;
  /** Rendered height in px; width is derived from the logo's aspect ratio. */
  height?: number;
  /** Override the accessible label (defaults to the brand name). */
  label?: string;
  className?: string;
};

/**
 * A single monochrome brand logo, tinted to `currentColor` via CSS mask.
 * Set the color on this element (or a parent) — e.g. `text-white/70` — and the
 * mark inherits it. `height` controls size; width follows the aspect ratio.
 */
export function BrandLogo({
  brand,
  height = 20,
  label,
  className,
}: BrandLogoProps) {
  const url = `/images/logos/${brand}.svg`;

  return (
    <span
      role="img"
      aria-label={label ?? LABEL[brand]}
      className={cn("inline-block shrink-0 bg-current align-middle", className)}
      style={{
        height,
        width: height * ASPECT[brand],
        WebkitMaskImage: `url(${url})`,
        maskImage: `url(${url})`,
        WebkitMaskRepeat: "no-repeat",
        maskRepeat: "no-repeat",
        WebkitMaskPosition: "center",
        maskPosition: "center",
        WebkitMaskSize: "contain",
        maskSize: "contain",
      }}
    />
  );
}
