import Image from "next/image";
import type { JSX } from "react";
import { cn } from "@/lib/cn";

/** Deterministic 32-bit hash — seeds the generated cover art per slug. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

type PostCoverProps = {
  /** Post slug — seeds the generated artwork. */
  seed: string;
  /** Optional real cover image (frontmatter `image`); overrides generation. */
  image?: string;
  title: string;
  className?: string;
  /** next/image priority for above-the-fold covers. */
  priority?: boolean;
};

/**
 * Article cover. With a frontmatter `image` it renders that; otherwise it
 * generates a deterministic crimzon panel per slug — a red glow whose position
 * and a sparse plus-grid vary with the seed, so every card reads distinct
 * without shipping any binary assets.
 */
export function PostCover({
  seed,
  image,
  title,
  className,
  priority = false,
}: PostCoverProps): JSX.Element {
  if (image) {
    return (
      <div
        className={cn(
          "relative overflow-hidden rounded-md border border-white/[0.08]",
          className,
        )}
      >
        <Image
          src={image}
          alt=""
          fill
          priority={priority}
          sizes="(min-width: 768px) 50vw, 100vw"
          className="object-cover"
        />
        <span className="sr-only">{title}</span>
      </div>
    );
  }

  const h = hash(seed);
  const glowX = 15 + (h % 70); // 15–84%
  const glowY = 20 + ((h >> 8) % 60); // 20–79%
  const glowSize = 55 + ((h >> 16) % 35); // 55–89%
  const marks = Array.from({ length: 5 }, (_, i) => {
    const m = hash(`${seed}:${i}`);
    return { left: 8 + (m % 84), top: 10 + ((m >> 10) % 78) };
  });

  return (
    <div
      aria-hidden="true"
      className={cn(
        "relative overflow-hidden rounded-md border border-white/[0.08] bg-[#0a0606]",
        className,
      )}
      style={{
        backgroundImage: `radial-gradient(${glowSize}% ${glowSize}% at ${glowX}% ${glowY}%, rgba(246,72,56,0.22), transparent 70%)`,
      }}
    >
      {marks.map((m) => (
        <span
          key={`${m.left}-${m.top}`}
          className="absolute font-mono text-[13px] text-white/15"
          style={{ left: `${m.left}%`, top: `${m.top}%` }}
        >
          +
        </span>
      ))}
      <span className="absolute right-4 bottom-3 font-mono text-[11px] text-white/25 uppercase tracking-[0.08em]">
        hogsend/blog
      </span>
    </div>
  );
}
