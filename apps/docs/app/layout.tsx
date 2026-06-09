import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import {
  OrganizationJsonLd,
  SoftwareApplicationJsonLd,
} from "@/components/seo/json-ld";
import { geistMono, inter, interDisplay } from "@/lib/fonts";
import { SITE_URL } from "@/lib/site";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Hogsend — Lifecycle email, written in TypeScript",
    template: "%s — Hogsend",
  },
  description:
    "Source-available lifecycle email engine for teams on PostHog. Durable TypeScript journeys in your repo, sent through your own Resend or Postmark account. No contact tax.",
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
        <SoftwareApplicationJsonLd />
        <OrganizationJsonLd />
      </body>
    </html>
  );
}
