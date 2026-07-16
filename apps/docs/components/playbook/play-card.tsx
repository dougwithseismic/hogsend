import Link from "next/link";
import type { JSX } from "react";
import { cn } from "@/lib/cn";
import type { PlayIndexEntry } from "@/lib/playbook";
import { CATEGORIES } from "@/lib/playbook/categories";
import { PERSONAS } from "@/lib/playbook/personas";

/**
 * Typographic library card — no cover image, category accent bar on top,
 * title + hook + persona chips + installs badge. Deliberately NOT the
 * articles feed look.
 */
export function PlayCard({
  play,
  className,
}: {
  play: PlayIndexEntry;
  className?: string;
}): JSX.Element {
  const category = CATEGORIES[play.category];
  return (
    <Link
      href={play.url}
      className={cn(
        "group relative flex flex-col gap-3 overflow-hidden rounded-md border",
        "border-white/[0.08] bg-white/[0.015] p-5 transition-colors",
        "duration-200 hover:border-white/15",
        className,
      )}
    >
      <span
        aria-hidden
        className="absolute inset-x-0 top-0 h-[2px]"
        style={{ backgroundColor: category.accent }}
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-mono text-[11px] uppercase tracking-[0.06em]"
          style={{ color: category.accent }}
        >
          {category.label}
        </span>
        {play.installs ? (
          <span className="rounded-[3px] border border-accent bg-accent-tint px-1.5 py-0.5 font-mono text-[10px] text-white uppercase tracking-[0.06em]">
            Installs
          </span>
        ) : null}
      </div>
      <h3 className="font-display text-[19px] text-white leading-[1.25] tracking-[-0.02em] transition-colors group-hover:text-white/85">
        {play.title}
      </h3>
      <p className="text-[14px] text-white/55 leading-[1.55]">{play.hook}</p>
      <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-2">
        {play.personas.map((p) => (
          <span
            key={p}
            className="rounded-full border border-white/10 px-2 py-0.5 font-mono text-[10px] text-white/45 uppercase tracking-[0.06em]"
          >
            {PERSONAS[p].short}
          </span>
        ))}
        {play.timeToResults ? (
          <span className="ml-auto text-[11px] text-white/35">
            Results: {play.timeToResults}
          </span>
        ) : null}
      </div>
    </Link>
  );
}
