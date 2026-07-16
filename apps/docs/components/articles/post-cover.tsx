import Image from "next/image";
import type { JSX } from "react";
import { cn } from "@/lib/cn";

/** Deterministic 32-bit hash — picks the default cover art per slug. */
function hash(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Crimzon abstract cover pool under /public — assigned by slug hash. */
const DEFAULT_COVERS = [
  "/images/articles/covers/cover-1.jpg",
  "/images/articles/covers/cover-2.jpg",
  "/images/articles/covers/cover-3.jpg",
  "/images/articles/covers/cover-4.jpg",
  "/images/articles/covers/cover-5.jpg",
  "/images/articles/covers/cover-6.jpg",
] as const;

type PostCoverProps = {
  /** Post slug — picks the default artwork deterministically. */
  seed: string;
  /** Optional explicit cover (frontmatter `image`); overrides the pool. */
  image?: string;
  title: string;
  className?: string;
  /** next/image priority for above-the-fold covers. */
  priority?: boolean;
};

/**
 * Article cover. Renders the frontmatter `image` when set; otherwise one of
 * the crimzon abstract defaults, chosen deterministically by slug so each
 * card keeps the same art forever without per-post frontmatter.
 */
export function PostCover({
  seed,
  image,
  title,
  className,
  priority = false,
}: PostCoverProps): JSX.Element {
  const src = image ?? DEFAULT_COVERS[hash(seed) % DEFAULT_COVERS.length];

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-md border border-white/[0.08] bg-[#0a0606]",
        className,
      )}
    >
      <Image
        src={src}
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
