import type { ReactNode } from "react";
import { PageFrame } from "@/components/ds/page-frame";
import { SiteFooter } from "@/components/landing/site-footer";
import { SiteNav } from "@/components/landing/site-nav";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-ink">
      <SiteNav />
      {children}
      <SiteFooter />
      {/* Full-height vertical hairlines at the 1200px frame edges — marketing pages only. */}
      <PageFrame />
    </div>
  );
}
