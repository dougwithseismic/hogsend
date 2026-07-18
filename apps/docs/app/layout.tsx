import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageViewTracker } from "@/components/analytics/page-view-tracker";
import { PosthogBoot } from "@/components/analytics/posthog-boot";
import { NamePrompt } from "@/components/auth/name-prompt";
import { CookieBanner } from "@/components/consent/cookie-banner";
import { ConsoleEgg } from "@/components/console-egg";
import { DevTools } from "@/components/devtools";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { FlagPreviewBanner } from "@/components/hogsend/flag-preview-banner";
import { HogsendDocsProvider } from "@/components/hogsend/provider";
import {
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
  WebSiteJsonLd,
} from "@/components/seo/json-ld";
import { geistMono, inter, interDisplay } from "@/lib/fonts";
import { SITE_URL, WITHSEISMIC_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Hogsend — Lifecycle automation in TypeScript",
    template: "%s — Hogsend",
  },
  description:
    "Lifecycle automation in TypeScript for product-led teams. Build onboarding, conversion, retention, and win-back journeys in your repo — with or without PostHog.",
  keywords: [
    "lifecycle automation framework",
    "product-led growth",
    "customer lifecycle",
    "typescript",
    "code-first",
    "agent-native",
    "posthog",
    "resend",
    "postmark",
    "email automation",
    "self-hosted",
    "transactional email",
    "hogsend",
  ],
  authors: [{ name: "Doug Silkstone", url: WITHSEISMIC_URL }],
  creator: "Doug Silkstone",
  publisher: "Hogsend",
  openGraph: {
    siteName: "Hogsend",
    type: "website",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
  icons: { icon: "/icon.png", apple: "/apple-icon.png" },
  formatDetection: { telephone: false },
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
        <RootProvider theme={{ enabled: false }}>
          <HogsendDocsProvider>
            {isHogsendConfigured ? <FlagPreviewBanner /> : null}
            {children}
            <NamePrompt />
          </HogsendDocsProvider>
        </RootProvider>
        {/* Boots PostHog from /api/posthog-config (runtime env — see the
            component for why build-time inlining is banned here). */}
        <PosthogBoot />
        <PageViewTracker />
        {/* Cookieless-by-default consent card: offers the durable-analytics
            upgrade to visitors who never hit the EmailCapture checkbox, and
            is reopenable via the footer's "Cookie settings" link. */}
        <CookieBanner />
        <SoftwareApplicationJsonLd />
        <OrganizationJsonLd />
        <WebSiteJsonLd />
        {/* Unified TanStack Devtools shell (built-in + product panels). Always
            on in dev; in production it's opt-in via the `?hs-devtools` URL flag
            so real visitors never load it (see components/devtools/index.tsx). */}
        <DevTools />
        {/* Postphant says hi — once — to whoever opens the console. */}
        <ConsoleEgg />
      </body>
    </html>
  );
}
