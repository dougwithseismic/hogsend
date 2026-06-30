import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { CSSProperties, ReactNode } from "react";
import { SiteNav } from "@/components/site-nav";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function LearnLayout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* The shared site nav sits in normal flow above the docs grid; telling
          Fumadocs the "banner" is 5rem (= the h-20 nav) offsets the sticky
          sidebar + mobile subnav so nothing renders under the nav. */}
      <SiteNav />
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions()}
        themeSwitch={{ enabled: false }}
        containerProps={{
          style: { "--fd-banner-height": "5rem" } as CSSProperties,
        }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
