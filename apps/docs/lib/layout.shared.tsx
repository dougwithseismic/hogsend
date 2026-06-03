import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: "Hogsend",
    },
    links: [
      { text: "Docs", url: "/docs" },
      { text: "Getting Started", url: "/docs/getting-started" },
      { text: "Compare", url: "/docs/compare" },
    ],
    githubUrl: "https://github.com/dougwithseismic/hogsend",
  };
}
