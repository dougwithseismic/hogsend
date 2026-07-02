"use client";

import { ArrowLeft, NotebookPen } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { type JSX, useEffect, useState } from "react";
import { ProgressBar } from "@/components/ds/progress-bar";
import { useSession } from "@/lib/auth-client";
import { getCourse } from "@/lib/courses";

/**
 * In-reader course context, shown at the top of the Fumadocs sidebar: the
 * course title, a link back to its overview, and — for signed-in readers — the
 * course's live workbook progress with a link to /workbook. Derives the
 * current course from the pathname (the layout has no per-lesson params), so
 * it stays a lightweight client component; progress comes from the small
 * /api/workbook summary endpoint.
 */
export function SidebarCourseBanner(): JSX.Element | null {
  const pathname = usePathname();
  const { data: session } = useSession();
  const slug = pathname
    .replace(/^\/learn\/?/, "")
    .split("/")
    .filter(Boolean)[0];
  const course = slug ? getCourse(slug) : undefined;

  const [progress, setProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);

  // Depends on the full pathname (not just the slug) so moving between
  // lessons of the same course refreshes the counts after in-lesson saves.
  useEffect(() => {
    const course = pathname
      .replace(/^\/learn\/?/, "")
      .split("/")
      .filter(Boolean)[0];
    if (!session || !course) return;
    let cancelled = false;
    fetch(`/api/workbook?course=${encodeURIComponent(course)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { done?: number; total?: number } | null) => {
        if (cancelled || !body || typeof body.done !== "number") return;
        setProgress({ done: body.done, total: body.total ?? 0 });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [session, pathname]);

  if (!course) return null;

  return (
    <div className="rounded-lg border border-white/[0.08] bg-white/[0.02] p-3">
      <p className="text-white/40 text-xs">Course</p>
      <p className="mt-0.5 font-display text-sm text-white tracking-[-0.02em]">
        {course.title}
      </p>
      <Link
        href={`/${slug}`}
        className="mt-2 inline-flex items-center gap-1.5 text-white/60 text-xs transition-colors hover:text-white"
      >
        <ArrowLeft className="size-3" aria-hidden /> Course overview
      </Link>

      <div className="mt-3 border-white/[0.08] border-t pt-3">
        <Link
          href="/workbook"
          className="group flex items-center gap-1.5 text-white/60 text-xs transition-colors hover:text-white"
        >
          <NotebookPen className="size-3" aria-hidden />
          <span>Your workbook</span>
          {progress ? (
            <span className="ml-auto text-white/40 group-hover:text-white/60">
              {progress.done}/{progress.total}
            </span>
          ) : null}
        </Link>
        {progress ? (
          <ProgressBar
            value={progress.done}
            max={progress.total}
            className="mt-2"
          />
        ) : null}
      </div>
    </div>
  );
}
