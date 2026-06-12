import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { baseOptions } from "@/lib/layout.shared";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      <AnnouncementBanner />
      <DocsLayout
        tree={source.getPageTree()}
        {...baseOptions()}
        // Dark-only site — hide the (now no-op) light/dark toggle.
        themeSwitch={{ enabled: false }}
      >
        {children}
      </DocsLayout>
    </>
  );
}
