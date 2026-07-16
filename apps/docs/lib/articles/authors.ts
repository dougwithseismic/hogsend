/**
 * Article author registry. A post's `author` frontmatter field must be a key
 * here. Guest authors get added as new entries — no code changes elsewhere.
 */
export type Author = {
  id: string;
  name: string;
  /** One-line role shown under the name. */
  role: string;
  /** Short bio for the article sidebar. */
  bio: string;
  /** Optional avatar under /public; initials render when absent. */
  avatar?: string;
  /** Optional external profile link (X, LinkedIn, personal site). */
  url?: string;
};

export const AUTHORS: Record<string, Author> = {
  doug: {
    id: "doug",
    name: "Doug Silkstone",
    role: "Founder, Hogsend",
    bio: "Fractional growth engineer. 15+ years building lifecycle and growth systems for clients — Hogsend is that stack, shipped as a framework.",
    url: "https://withseismic.com",
  },
};

export function getAuthor(id: string): Author {
  const author = AUTHORS[id];
  if (!author) throw new Error(`Unknown article author: ${id}`);
  return author;
}
