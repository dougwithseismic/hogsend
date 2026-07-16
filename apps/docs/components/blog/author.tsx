import Image from "next/image";
import type { JSX } from "react";
import type { Author } from "@/lib/blog/authors";
import { cn } from "@/lib/cn";

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();
}

export function AuthorAvatar({
  author,
  size = 32,
  className,
}: {
  author: Author;
  size?: number;
  className?: string;
}): JSX.Element {
  return (
    <span
      className={cn(
        "relative flex shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/15 bg-white/[0.06]",
        className,
      )}
      style={{ width: size, height: size }}
    >
      {author.avatar ? (
        <Image src={author.avatar} alt={author.name} fill sizes={`${size}px`} />
      ) : (
        <span
          className="font-medium text-white/80"
          style={{ fontSize: size * 0.36 }}
        >
          {initials(author.name)}
        </span>
      )}
    </span>
  );
}

/** Inline byline: avatar + name (+ optional trailing meta on the same row). */
export function AuthorChip({
  author,
  meta,
  className,
}: {
  author: Author;
  meta?: string;
  className?: string;
}): JSX.Element {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <AuthorAvatar author={author} size={28} />
      <span className="text-sm text-white/70">{author.name}</span>
      {meta ? (
        <>
          <span aria-hidden="true" className="text-white/25">
            ·
          </span>
          <span className="text-sm text-white/45">{meta}</span>
        </>
      ) : null}
    </span>
  );
}

/** Article sidebar author block: avatar, name, role, short bio, link. */
export function AuthorSidebar({ author }: { author: Author }): JSX.Element {
  return (
    <div className="flex flex-col gap-3">
      <AuthorAvatar author={author} size={48} />
      <div>
        <p className="font-medium text-base text-white">{author.name}</p>
        <p className="text-sm text-white/50">{author.role}</p>
      </div>
      <p className="text-sm text-white/60 leading-5">{author.bio}</p>
      {author.url ? (
        <a
          href={author.url}
          target="_blank"
          rel="noreferrer"
          className="text-accent text-sm hover:text-accent/80"
        >
          {author.url.replace(/^https?:\/\//, "")}
        </a>
      ) : null}
    </div>
  );
}
