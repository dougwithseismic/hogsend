import Link from "next/link";
import type { JSX } from "react";
import { type BlogPost, formatPostDate } from "@/lib/blog";
import { getAuthor } from "@/lib/blog/authors";
import { TAGS, type TagSlug } from "@/lib/blog/tags";
import { cn } from "@/lib/cn";
import { AuthorChip } from "./author";
import { PostCover } from "./post-cover";

function TagRow({ tags }: { tags: string[] }): JSX.Element {
  return (
    <span className="flex flex-wrap gap-2">
      {tags.map((t) => (
        <span
          key={t}
          className="rounded-full border border-white/10 px-2.5 py-0.5 font-mono text-[11px] text-white/50 uppercase tracking-[0.06em]"
        >
          {TAGS[t as TagSlug]?.label ?? t}
        </span>
      ))}
    </span>
  );
}

/**
 * Featured post: full-width band — cover left, content right on desktop.
 * The big card at the top of /blog.
 */
export function FeaturedPostCard({ post }: { post: BlogPost }): JSX.Element {
  const author = getAuthor(post.data.author);
  return (
    <Link
      href={post.url}
      className="group grid gap-6 rounded-md border border-white/[0.08] bg-white/[0.015] p-6 transition-colors duration-200 hover:border-white/15 md:grid-cols-2 md:gap-10 md:p-8"
    >
      <PostCover
        seed={post.url}
        image={post.data.image}
        title={post.data.title}
        priority
        className="aspect-[16/10] w-full"
      />
      <div className="flex flex-col justify-center gap-4">
        <TagRow tags={post.data.tags} />
        <h2 className="font-display text-[28px] text-white leading-[1.15] tracking-[-0.02em] transition-colors group-hover:text-white/85 md:text-[36px]">
          {post.data.title}
        </h2>
        {post.data.description ? (
          <p className="max-w-xl text-base text-white/60 leading-6">
            {post.data.description}
          </p>
        ) : null}
        <AuthorChip author={author} meta={formatPostDate(post.data.date)} />
      </div>
    </Link>
  );
}

/**
 * Feed card: horizontal on desktop (cover left ~40%, content right), stacked
 * on mobile — the STRV-style "Latest" list row.
 */
export function PostCard({
  post,
  className,
}: {
  post: BlogPost;
  className?: string;
}): JSX.Element {
  const author = getAuthor(post.data.author);
  return (
    <Link
      href={post.url}
      className={cn(
        "group grid gap-5 border-white/[0.08] border-t py-8 md:grid-cols-[2fr_3fr] md:gap-10",
        className,
      )}
    >
      <PostCover
        seed={post.url}
        image={post.data.image}
        title={post.data.title}
        className="aspect-[16/10] w-full"
      />
      <div className="flex flex-col justify-center gap-3">
        <TagRow tags={post.data.tags} />
        <h3 className="font-display text-[22px] text-white leading-[1.2] tracking-[-0.02em] transition-colors group-hover:text-white/85 md:text-[26px]">
          {post.data.title}
        </h3>
        {post.data.description ? (
          <p className="max-w-xl text-[15px] text-white/60 leading-6">
            {post.data.description}
          </p>
        ) : null}
        <AuthorChip author={author} meta={formatPostDate(post.data.date)} />
      </div>
    </Link>
  );
}

/** Compact card for the related-posts grid at the bottom of an article. */
export function RelatedPostCard({ post }: { post: BlogPost }): JSX.Element {
  const author = getAuthor(post.data.author);
  return (
    <Link
      href={post.url}
      className="group flex flex-col gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] p-5 transition-colors duration-200 hover:border-white/15"
    >
      <PostCover
        seed={post.url}
        image={post.data.image}
        title={post.data.title}
        className="aspect-[16/10] w-full"
      />
      <h3 className="font-display text-lg text-white leading-[1.25] tracking-[-0.02em] transition-colors group-hover:text-white/85">
        {post.data.title}
      </h3>
      <AuthorChip
        author={author}
        meta={formatPostDate(post.data.date)}
        className="mt-auto"
      />
    </Link>
  );
}
