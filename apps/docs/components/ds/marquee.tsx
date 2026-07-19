import { cn } from "@/lib/cn";

type LogoMarqueeProps = {
  items: React.ReactNode[];
  className?: string;
  /** Seconds per loop (default 36). Vary per lane for a layered feel. */
  durationSec?: number;
  /** Run right-to-left → left-to-right instead. */
  reverse?: boolean;
};

/**
 * Horizontal auto-scrolling logo strip. Pure CSS — a duplicated track is
 * translated by -50% on a seamless loop, with an edge fade mask so logos
 * dissolve into the section at both ends. Server component (no hooks).
 *
 * Respects prefers-reduced-motion (global CSS pauses/limits animation).
 */
export function LogoMarquee({
  items,
  className,
  durationSec,
  reverse,
}: LogoMarqueeProps) {
  // Two copies of the track so the -50% translate wraps seamlessly. We mark
  // the duplicate aria-hidden so screen readers only announce one set.
  return (
    <div
      className={cn(
        "no-scrollbar relative w-full overflow-hidden",
        // edge fade — logos fade out toward both horizontal edges
        "[mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]",
        "[-webkit-mask-image:linear-gradient(to_right,transparent,black_12%,black_88%,transparent)]",
        className,
      )}
    >
      <style>{`
@keyframes hs-marquee {
  from { transform: translateX(0); }
  to { transform: translateX(-50%); }
}
.hs-marquee-track {
  display: flex;
  width: max-content;
  flex-wrap: nowrap;
  align-items: center;
  animation: hs-marquee 36s linear infinite;
  will-change: transform;
}
.hs-marquee-root:hover .hs-marquee-track {
  animation-play-state: paused;
}
@media (prefers-reduced-motion: reduce) {
  .hs-marquee-track {
    animation: none;
    transform: translateX(0);
  }
}
`}</style>
      <div className="hs-marquee-root">
        <div
          className="hs-marquee-track"
          style={{
            ...(durationSec ? { animationDuration: `${durationSec}s` } : null),
            ...(reverse ? { animationDirection: "reverse" } : null),
          }}
        >
          {/* primary set */}
          <ul className="flex shrink-0 list-none items-center gap-12 pr-12">
            {items.map((item, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static logo list, order is stable
                key={`a-${i}`}
                className="flex shrink-0 items-center justify-center opacity-60 transition-opacity hover:opacity-100"
              >
                {item}
              </li>
            ))}
          </ul>
          {/* duplicated set for the seamless loop */}
          <ul
            aria-hidden="true"
            className="flex shrink-0 list-none items-center gap-12 pr-12"
          >
            {items.map((item, i) => (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: static logo list, order is stable
                key={`b-${i}`}
                className="flex shrink-0 items-center justify-center opacity-60"
              >
                {item}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
