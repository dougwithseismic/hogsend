import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageViewTracker } from "@/components/analytics/page-view-tracker";
import { PosthogBoot } from "@/components/analytics/posthog-boot";
import {
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
} from "@/components/seo/json-ld";
import { geistMono, inter, interDisplay } from "@/lib/fonts";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Hogsend — Lifecycle email that lives in your repo",
    template: "%s — Hogsend",
  },
  description:
    "Welcome series, trial nudges, win-backs, payment saves — running from your repo on PostHog and product events, sent through your own Resend or Postmark account. Free to self-host.",
  openGraph: {
    siteName: "Hogsend",
    type: "website",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/icon.svg", apple: "/apple-icon.png" },
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${interDisplay.variable} ${inter.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-ink font-sans text-white antialiased">
        {/* Dark-only site (matches the brand). The theme toggle is disabled. */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
        {/* Boots PostHog from /api/posthog-config (runtime env — see the
            component for why build-time inlining is banned here). */}
        <PosthogBoot />
        <PageViewTracker />
        <SoftwareApplicationJsonLd />
        <OrganizationJsonLd />
      </body>
    </html>
  );
}
