import { Montserrat } from "next/font/google";
import type { ReactNode } from "react";
import { PsNav } from "@/app/(landing)/_components/nav";
import { AnnouncementBanner } from "@/components/announcement-banner";
import { PageFrame } from "@/components/ds/page-frame";
import { SiteFooter } from "@/components/landing/site-footer";

/**
 * The homepage's `PsNav` is now the site-wide marketing nav (replacing the old
 * `SiteNav`). It's rendered `fixed` here so the existing pages' top clearance
 * (pt-32) keeps working unchanged, and the announcement banner stays above it —
 * `--fd-banner-height` offsets the fixed nav below the banner.
 *
 * The nav wordmark uses `--ps-display` (Montserrat, the homepage display face),
 * so we load it here too; scoped to the marketing pages, its only consumer is
 * the nav lockup.
 */
const display = Montserrat({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--ps-display",
  display: "swap",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div
      className={`${display.variable} flex min-h-screen flex-col overflow-x-clip bg-ink`}
    >
      {/* In normal flow, so it pushes the page down by its own height; the
          fixed PsNav sits below it via --fd-banner-height. */}
      <AnnouncementBanner />
      <PsNav fixed />
      {children}
      <SiteFooter />
      {/* Full-height vertical hairlines at the 1200px frame edges — marketing pages only. */}
      <PageFrame />
    </div>
  );
}
