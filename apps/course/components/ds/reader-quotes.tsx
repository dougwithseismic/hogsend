import type { JSX } from "react";
import { cn } from "@/lib/cn";

export type ReaderQuote = {
  /** The reader's words, verbatim — never invented or embellished. */
  quote: string;
  name: string;
  /** e.g. "Early reader" — how they came by the course. */
  role?: string;
};

function Attribution({ q }: { q: ReaderQuote }): JSX.Element {
  return (
    <span className="font-mono text-[12px] text-white/45 uppercase tracking-[0.08em]">
      {q.name}
      {q.role ? <span className="text-white/30"> · {q.role}</span> : null}
    </span>
  );
}

/**
 * Real reader quotes. One quote renders as a single large centred pull-quote;
 * two or more render as a card grid. Data-driven so new quotes are a one-line
 * append — the layout upgrades itself.
 */
export function ReaderQuotes({
  quotes,
  className,
}: {
  quotes: ReaderQuote[];
  className?: string;
}): JSX.Element | null {
  if (quotes.length === 0) return null;

  if (quotes.length === 1) {
    const q = quotes[0] as ReaderQuote;
    return (
      <figure
        className={cn(
          "mx-auto flex max-w-3xl flex-col items-center text-center",
          className,
        )}
      >
        <blockquote className="font-display text-[26px] text-white/90 leading-[1.3] tracking-[-0.02em] md:text-[34px]">
          “{q.quote}”
        </blockquote>
        <figcaption className="mt-6">
          <Attribution q={q} />
        </figcaption>
      </figure>
    );
  }

  return (
    <div className={cn("grid gap-6 md:grid-cols-2 lg:grid-cols-3", className)}>
      {quotes.map((q) => (
        <figure
          key={`${q.name}:${q.quote.slice(0, 32)}`}
          className="flex h-full flex-col rounded-md border border-white/[0.08] bg-white/[0.015] p-6"
        >
          <blockquote className="text-base text-white/80 leading-7">
            “{q.quote}”
          </blockquote>
          <figcaption className="mt-auto pt-5">
            <Attribution q={q} />
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
