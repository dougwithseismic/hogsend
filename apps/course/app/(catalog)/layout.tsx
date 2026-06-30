import type { ReactNode } from "react";
import { PageFrame } from "@/components/ds/page-frame";
import { SiteFooter } from "@/components/site-footer";
import { SiteNav } from "@/components/site-nav";

/** Public catalog shell: shared brand nav + footer + the crimzon page frame. */
export default function CatalogLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <PageFrame />
      <div className="relative z-10 flex min-h-screen flex-col">
        <SiteNav />
        <main className="flex-1">{children}</main>
        <SiteFooter />
      </div>
    </>
  );
}
