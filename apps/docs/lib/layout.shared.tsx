import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Download } from "lucide-react";
import { Logo } from "@/components/landing/logo";
import { DESKTOP_DOWNLOAD_URL } from "@/lib/site";

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
      {
        type: "icon",
        label: "Download the Hogsend Mac app",
        icon: <Download />,
        text: "Download",
        url: DESKTOP_DOWNLOAD_URL,
        external: true,
      },
    ],
    githubUrl: "https://github.com/dougwithseismic/hogsend",
  };
}
