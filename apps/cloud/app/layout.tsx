import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageFrame } from "@/components/ds/page-frame";
import { NavRail } from "@/components/shell/nav-rail";
import { geistMono, inter, interDisplay } from "@/lib/fonts";
import "./global.css";

export const metadata: Metadata = {
  title: {
    default: "Hogsend Cloud",
    template: "%s — Hogsend Cloud",
  },
  description: "Control plane for managed Hogsend instances.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html
      lang="en"
      className={`dark ${interDisplay.variable} ${inter.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-dvh bg-ink font-sans text-white antialiased">
        <NavRail />
        {/* The rail is fixed at md+, so the content column carries its width
            as a left offset. Below md the rail sits in flow above it. */}
        <div className="relative z-10 flex min-h-dvh flex-col md:pl-rail">
          {children}
        </div>
        {/* Vertical hairlines at the content frame's edges + film grain. */}
        <PageFrame />
      </body>
    </html>
  );
}
