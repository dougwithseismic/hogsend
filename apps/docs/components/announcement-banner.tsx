import { Banner } from "fumadocs-ui/components/banner";
import type { JSX } from "react";
import { BannerTicker } from "@/components/landing/banner-ticker";

/**
 * Top banner shared by both site chromes (marketing + docs). It's deliberately
 * NON-dismissable: the banner IS the realtime-notification showcase (a live feed
 * ticker you can click to open the bell), so a close button would let visitors
 * throw away the very thing we're demoing. Fumadocs only renders the close (X)
 * when an `id` is set, so omitting `id` removes it; `--fd-banner-height` is
 * driven by the separate `changeLayout` prop (default true), so the marketing
 * SiteNav and docs layout still get their offset. The content is a feed-driven
 * ticker (see {@link BannerTicker}): the "Try it live" CTA cold, a personalized
 * greeting or realtime notification ticker once we know the visitor.
 */
export function AnnouncementBanner(): JSX.Element {
  return (
    <Banner
      height="2.5rem"
      className="gap-1.5 border-hairline-faint border-b bg-ink/90 font-normal backdrop-blur-[7px]"
    >
      <BannerTicker />
    </Banner>
  );
}
