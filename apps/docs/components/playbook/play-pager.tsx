import { ArrowLeft, ArrowRight } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import type { PlayIndexEntry } from "@/lib/playbook";

/** Prev/next play navigation at the bottom of every play — continuity
 * through the library in the same order as the index grid. */
export function PlayPager({
  prev,
  next,
}: {
  prev?: PlayIndexEntry;
  next?: PlayIndexEntry;
}): JSX.Element | null {
  if (!prev && !next) return null;

  return (
    <nav
      aria-label="More plays"
      className="grid gap-4 border-white/[0.08] border-t pt-8 sm:grid-cols-2"
    >
      {prev ? (
        <Link
          href={prev.url}
          className="group flex flex-col gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.015] p-4 transition-colors duration-200 hover:border-white/15"
        >
          <span className="inline-flex items-center gap-1.5 font-mono text-[11px] text-white/45 uppercase tracking-[0.06em]">
            <ArrowLeft
              className="size-3 transition-transform duration-200 group-hover:-translate-x-0.5"
              strokeWidth={2}
            />
            Previous play
          </span>
          <span className="text-[15px] text-white leading-snug tracking-[-0.01em]">
            {prev.title}
          </span>
        </Link>
      ) : (
        <span aria-hidden="true" className="hidden sm:block" />
      )}
      {next ? (
        <Link
          href={next.url}
          className="group flex flex-col gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.015] p-4 text-right transition-colors duration-200 hover:border-white/15 sm:items-end"
        >
          <span className="inline-flex items-center gap-1.5 self-end font-mono text-[11px] text-white/45 uppercase tracking-[0.06em]">
            Next play
            <ArrowRight
              className="size-3 transition-transform duration-200 group-hover:translate-x-0.5"
              strokeWidth={2}
            />
          </span>
          <span className="text-[15px] text-white leading-snug tracking-[-0.01em]">
            {next.title}
          </span>
        </Link>
      ) : null}
    </nav>
  );
}
