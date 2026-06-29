import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { GITHUB_URL, HOGSEND_URL } from "@/lib/site";

/** Shared options for the fumadocs DocsLayout used by the lesson reader. */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-display font-medium tracking-[-0.02em]">
          Hogsend <span className="text-white/40">Courses</span>
        </span>
      ),
      transparentMode: "none",
    },
    links: [
      { text: "All courses", url: "/" },
      { text: "Hogsend", url: HOGSEND_URL },
    ],
    githubUrl: GITHUB_URL,
  };
}
