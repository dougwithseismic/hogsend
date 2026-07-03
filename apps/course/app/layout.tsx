import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { geistMono, inter, interDisplay } from "@/lib/fonts";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Hogsend Courses — Build your growth in code",
    template: "%s — Hogsend Courses",
  },
  description:
    "Free, code-first courses on PostHog, lifecycle messaging, and turning traffic into an audience you own — from the team behind Hogsend.",
  openGraph: {
    siteName: "Hogsend Courses",
    type: "website",
    url: SITE_URL,
  },
  twitter: { card: "summary_large_image" },
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${interDisplay.variable} ${inter.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-ink font-sans text-white antialiased">
        {/* Dark-only (matches the crimzon brand). Theme toggle disabled. */}
        {/* The Hogsend feed provider is NOT here: it only feeds the nav bell,
            and its identity-driven remount (anon → identified, once the feed
            token lands ~0.5s post-load) would otherwise tear down and re-fade
            the whole page. It's scoped to <SiteNav> so only the nav remounts. */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
