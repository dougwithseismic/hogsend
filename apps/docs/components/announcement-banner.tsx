import { Banner } from "fumadocs-ui/components/banner";
import type { JSX } from "react";
import { LINKEDIN_URL } from "@/lib/site";

/**
 * Early-days notice shared by both site chromes (marketing + docs). The id
 * makes it dismissable once per browser; while visible, fumadocs sets
 * --fd-banner-height on :root, which the marketing SiteNav and the docs
 * layout both use to offset themselves.
 */
export function AnnouncementBanner(): JSX.Element {
  return (
    <Banner
      id="hogsend-early-days"
      height="2.5rem"
      className="gap-1.5 border-hairline-faint border-b bg-ink/90 font-normal backdrop-blur-[7px]"
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
  );
}
