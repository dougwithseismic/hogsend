import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties, ReactNode } from "react";
import { SidebarCourseBanner } from "@/components/sidebar-course-banner";
import { SiteNav } from "@/components/site-nav";
import { decorateTree } from "@/lib/course-ui";
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
  // resolve the viewer's owned SKUs here and only lock lessons they can't read.
  const session = await getSession();
  const ownedSlugs = session
    ? await listOwnedSlugs(session.user.id)
    : new Set<string>();

  return (
    <>
      {/* The shared site nav sits in normal flow above the docs grid; telling
          Fumadocs the "banner" is 5rem (= the h-20 nav) offsets the sticky
          sidebar + mobile subnav so nothing renders under the nav. */}
      <SiteNav />
      <DocsLayout
        tree={decorateTree(source.getPageTree(), ownedSlugs)}
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
