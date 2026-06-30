import { Check, Lock } from "lucide-react";
import Link from "next/link";
import type { JSX } from "react";
import { PillBadge, TagPill } from "@/components/ds/badge";
import { Card } from "@/components/ds/card";
import type { CourseCardView } from "@/lib/catalog";
import { cn } from "@/lib/cn";

/** The state chip shown top-right of a course card. */
function StateBadge({ view }: { view: CourseCardView }): JSX.Element {
  switch (view.state) {
    case "owned":
      return (
        <TagPill accent>
          <Check className="mr-1 size-3" strokeWidth={2.5} aria-hidden /> Owned
        </TagPill>
      );
    case "locked":
      return (
        <TagPill>
          <Lock className="mr-1 size-3" strokeWidth={2} aria-hidden />
          {view.priceLabel ?? "Locked"}
        </TagPill>
      );
    case "coming-soon":
      return (
        <TagPill>
          <Lock className="mr-1 size-3" strokeWidth={2} aria-hidden /> Coming
          soon
        </TagPill>
      );
    default:
      return <TagPill accent>Free</TagPill>;
  }
}

/**
 * A catalog course card showing its lock/owned/free/coming-soon state, price,
 * lesson count, estimate, and a progress bar once the reader has started it.
 * Always a link to the course overview (coming-soon links to its teaser).
 */
export function CourseCard({ view }: { view: CourseCardView }): JSX.Element {
  const isComingSoon = view.state === "coming-soon";
  const pct = view.progress
    ? Math.round((view.progress.done / view.progress.total) * 100)
    : 0;

  return (
    <Link href={view.href} className="group block">
      <Card
        className={cn(
          "flex h-full flex-col gap-4 group-hover:border-white/15",
          isComingSoon && "opacity-70",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <PillBadge>{view.level}</PillBadge>
          <StateBadge view={view} />
        </div>

        <h2 className="font-display text-2xl leading-tight tracking-[-0.02em]">
          {view.title}
        </h2>
        <p className="text-base text-white/60 leading-6">{view.tagline}</p>

        {view.progress ? (
          <div className="mt-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.06]">
              <div
                className="h-full rounded-full bg-accent transition-all"
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="mt-2 text-white/40 text-xs">
              {view.progress.done}/{view.progress.total} lessons · {pct}%
            </p>
          </div>
        ) : null}

        <div className="mt-auto flex items-center gap-3 pt-4 text-sm text-white/40">
          {isComingSoon ? (
            <span>In production</span>
          ) : (
            <>
              <span>{view.lessonCount} lessons</span>
              <span aria-hidden>·</span>
              <span>{view.estimate}</span>
            </>
          )}
        </div>
      </Card>
    </Link>
  );
}
