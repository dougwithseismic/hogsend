import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

/**
 * Shared options for the fumadocs DocsLayout used by the lesson reader. The top
 * chrome now comes from our own <SiteNav/> rendered above DocsLayout (see
 * app/learn/layout.tsx), so this no longer duplicates a desktop nav title/links
 * here. `nav` stays enabled (default) so the mobile header keeps its sidebar
 * (lesson-list) trigger.
 */
export function baseOptions(): BaseLayoutProps {
  return {
    nav: { transparentMode: "none" },
  };
}
