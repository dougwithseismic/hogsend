import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { DownloadNavLink } from "@/components/download-nav-link";
import { Logo } from "@/components/landing/logo";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: <Logo />,
      transparentMode: "none",
    },
    links: [
      { text: "Docs", url: "/docs" },
      { text: "Getting Started", url: "/docs/getting-started" },
      { text: "Compare", url: "/docs/compare" },
      // Download link sits in the icon row next to GitHub, but only renders on
      // macOS (the only build today) — see DownloadNavLink.
      { type: "custom", secondary: true, children: <DownloadNavLink /> },
    ],
    githubUrl: "https://github.com/dougwithseismic/hogsend",
  };
}
