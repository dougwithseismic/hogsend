import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { Cabin, Geist_Mono, Schibsted_Grotesk } from "next/font/google";
import type { ReactNode } from "react";

// Display: Schibsted Grotesk (all headings). Body: Cabin. Mono: Geist Mono.
// Exposed as CSS variables and wired into the Tailwind theme in global.css.
const display = Schibsted_Grotesk({
  subsets: ["latin"],
  variable: "--ff-display",
  display: "swap",
});

const sans = Cabin({
  subsets: ["latin"],
  variable: "--ff-body",
  display: "swap",
});

const mono = Geist_Mono({
  subsets: ["latin"],
  variable: "--ff-mono",
  display: "swap",
});

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-ink font-sans text-white antialiased">
        {/* Dark-only site (matches the brand). The theme toggle is disabled. */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
