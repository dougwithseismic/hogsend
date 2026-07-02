import { eq } from "drizzle-orm";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties, ReactNode } from "react";
import { SidebarCourseBanner } from "@/components/sidebar-course-banner";
import { SiteNav } from "@/components/site-nav";
import { decorateTree } from "@/lib/course-ui";
import { db } from "@/lib/db";
import { lessonProgress } from "@/lib/db/schema";
import { listOwnedSlugs } from "@/lib/entitlements";
import { getSession } from "@/lib/gating";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default async function LearnLayout({
  children,
}: {
  children: ReactNode;
}) {
  // The reader is already per-request (the lesson page is force-dynamic), so we
  // resolve the viewer's owned SKUs + completed lessons here — locks on what
  // they can't read, checks on what they've finished.
  const session = await getSession();
  const [ownedSlugs, completedLessons] = session
    ? await Promise.all([
        listOwnedSlugs(session.user.id),
        db
          .select({
            courseSlug: lessonProgress.courseSlug,
            lessonSlug: lessonProgress.lessonSlug,
          })
          .from(lessonProgress)
          .where(eq(lessonProgress.userId, session.user.id))
          .then(
            (rows) =>
              new Set(rows.map((r) => `${r.courseSlug}/${r.lessonSlug}`)),
          ),
      ])
    : [new Set<string>(), new Set<string>()];

  return (
    <>
      {/* The shared site nav sits in normal flow above the docs grid; telling
          Fumadocs the "banner" is 5rem (= the h-20 nav) offsets the sticky
          sidebar + mobile subnav so nothing renders under the nav. */}
      <SiteNav />
      <DocsLayout
        tree={decorateTree(source.getPageTree(), ownedSlugs, completedLessons)}
        {...baseOptions()}
        themeSwitch={{ enabled: false }}
        sidebar={{ banner: <SidebarCourseBanner key="course-banner" /> }}
        containerProps={{
          style: { "--fd-banner-height": "5rem" } as CSSProperties,
        }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
