/**
 * Article tag registry. Every `tags` entry in a post's frontmatter must be a key
 * here — unknown tags fail the build via `getTag` in lib/articles/index.ts.
 */
export const TAGS = {
  growth: { label: "Growth" },
  "technical-marketing": { label: "Technical marketing" },
  gtm: { label: "Go-to-market" },
  lifecycle: { label: "Lifecycle" },
  engineering: { label: "Engineering" },
} as const;

export type TagSlug = keyof typeof TAGS;

export function isTagSlug(slug: string): slug is TagSlug {
  return slug in TAGS;
}
