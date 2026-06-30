"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { JSX } from "react";
import { getCourse } from "@/lib/courses";

/**
 * In-reader course context, shown at the top of the Fumadocs sidebar. Derives
 * the current course from the pathname (the layout has no per-lesson params),
 * so it stays a lightweight client component. Imports only the pure courses
 * data module — no Stripe/DB — so nothing server-only leaks into the bundle.
 */
export function SidebarCourseBanner(): JSX.Element | null {
  const pathname = usePathname();
  const slug = pathname
    .replace(/^\/learn\/?/, "")
    .split("/")
    .filter(Boolean)[0];
  const course = slug ? getCourse(slug) : undefined;
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
    </div>
  );
}
