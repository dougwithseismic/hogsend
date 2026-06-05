import { RootProvider } from "fumadocs-ui/provider/next";
import "./global.css";
import { EB_Garamond, Figtree, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";

// Display: EB Garamond (all headings, light serif). Body: Figtree. Mono: Geist Mono.
// Exposed as CSS variables and wired into the Tailwind theme in global.css.
const display = EB_Garamond({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--ff-display",
  display: "swap",
});

const sans = Figtree({
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
      className={`${display.variable} ${sans.variable} ${mono.variable}`}
      suppressHydrationWarning
    >
      <body className="flex min-h-screen flex-col bg-lumen font-sans text-ink antialiased">
        {/* Light cream site (Wispr Flow homage). The theme toggle is disabled. */}
        <RootProvider theme={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
