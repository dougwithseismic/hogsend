import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
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
    ],
    githubUrl: "https://github.com/dougwithseismic/hogsend",
  };
}
