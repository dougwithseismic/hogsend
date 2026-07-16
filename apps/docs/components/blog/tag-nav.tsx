import Link from "next/link";
import type { JSX } from "react";
import type { TagSlug } from "@/lib/blog/tags";
import { cn } from "@/lib/cn";

type TagNavProps = {
  tags: { slug: TagSlug; label: string; count: number }[];
  /** The active tag slug, or undefined on the unfiltered /blog page. */
  active?: TagSlug;
};

/** Horizontal tag filter row under the blog header — "All" + live tags. */
export function TagNav({ tags, active }: TagNavProps): JSX.Element {
  const pill = (isActive: boolean) =>
    cn(
      "shrink-0 rounded-full border px-4 py-1.5 text-sm transition-colors duration-200",
      isActive
        ? "border-accent/60 bg-accent-tint text-white"
        : "border-white/10 text-white/60 hover:border-white/25 hover:text-white",
    );

  return (
    <nav
      aria-label="Blog topics"
      className="flex gap-2 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      <Link href="/blog" className={pill(active === undefined)}>
        All
      </Link>
      {tags.map((t) => (
        <Link
          key={t.slug}
          href={`/blog/tag/${t.slug}`}
          className={pill(active === t.slug)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
