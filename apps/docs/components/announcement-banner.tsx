import { Banner } from "fumadocs-ui/components/banner";
import type { JSX } from "react";
import { BannerTicker } from "@/components/landing/banner-ticker";

/**
 * Top banner shared by both site chromes (marketing + docs). The id makes it
 * dismissable once per browser; while visible, fumadocs sets --fd-banner-height
 * on :root, which the marketing SiteNav and the docs layout both use to offset
 * themselves. The content is a feed-driven ticker (see {@link BannerTicker}):
 * the classic "Chat to Doug" CTA cold, a personalized greeting + realtime
 * notification ticker once we know the visitor.
 */
export function AnnouncementBanner(): JSX.Element {
  return (
    <Banner
      id="hogsend-live-ticker"
      height="2.5rem"
      className="gap-1.5 border-hairline-faint border-b bg-ink/90 font-normal backdrop-blur-[7px]"
    >
      <BannerTicker />
    </Banner>
  );
}
