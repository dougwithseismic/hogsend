import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PageFrame } from "@/components/ds/page-frame";
import { AppChrome } from "@/components/shell/app-chrome";
import { OrgSwitcher } from "@/components/shell/org-switcher";
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
        {/* Nav rail + content offset, or a bare column on the auth screens.
            The switcher is rendered HERE (a server component) and handed down,
            because AppChrome and NavRail are both client components. */}
        <AppChrome orgSwitcher={<OrgSwitcher />}>{children}</AppChrome>
        {/* Vertical hairlines at the content frame's edges + film grain. */}
        <PageFrame />
      </body>
    </html>
  );
}
