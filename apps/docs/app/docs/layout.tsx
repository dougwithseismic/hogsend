import { Banner } from "fumadocs-ui/components/banner";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import type { ReactNode } from "react";
import { baseOptions } from "@/lib/layout.shared";
import { LINKEDIN_URL } from "@/lib/site";
import { source } from "@/lib/source";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <>
      {/* Early-days notice. The id makes it dismissable (persisted per
          browser); fumadocs offsets the docs chrome via --fd-banner-height. */}
      <Banner
        id="hogsend-early-days"
        height="2.5rem"
        className="gap-1.5 border-hairline-faint border-b font-normal"
      >
        <span className="text-white/60">Hogsend is brand new.</span>
        <a
          href={LINKEDIN_URL}
          target="_blank"
          rel="noreferrer"
          className="rounded font-medium text-white outline-none transition-colors hover:text-accent focus-visible:ring-2 focus-visible:ring-accent"
        >
          Chat to Doug
          <span className="hidden sm:inline">
            {" "}
            about it — he’ll help you get set up
          </span>
          <span aria-hidden="true"> →</span>
        </a>
      </Banner>
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
