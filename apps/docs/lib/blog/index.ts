import { blog } from "collections/server";
import { loader } from "fumadocs-core/source";
import { toFumadocsSource } from "fumadocs-mdx/runtime/server";
import { getAuthor } from "./authors";
import { isTagSlug, TAGS, type TagSlug } from "./tags";

export const blogSource = loader({
  baseUrl: "/blog",
  source: toFumadocsSource(blog, []),
});

export type BlogPost = ReturnType<typeof blogSource.getPages>[number];

/** All posts, newest first. Validates author + tags so typos fail the build. */
export function getAllPosts(): BlogPost[] {
  const posts = blogSource.getPages();
  for (const post of posts) {
    getAuthor(post.data.author);
    for (const tag of post.data.tags) {
      if (!isTagSlug(tag)) {
        throw new Error(`Unknown blog tag "${tag}" in ${post.url}`);
      }
    }
  }
  return posts.sort((a, b) => b.data.date.localeCompare(a.data.date));
}

/** The pinned featured post (falls back to the newest post). */
export function getFeaturedPost(posts: BlogPost[]): BlogPost | undefined {
  return posts.find((p) => p.data.featured) ?? posts[0];
}

export function getPostsByTag(posts: BlogPost[], tag: TagSlug): BlogPost[] {
  return posts.filter((p) => p.data.tags.includes(tag));
}

/** Tags that have at least one post, in registry order. */
export function getLiveTags(
  posts: BlogPost[],
): { slug: TagSlug; label: string; count: number }[] {
  return (Object.keys(TAGS) as TagSlug[])
    .map((slug) => ({
      slug,
      label: TAGS[slug].label,
      count: getPostsByTag(posts, slug).length,
    }))
    .filter((t) => t.count > 0);
}

/** Up to `limit` other posts sharing a tag, newest first; pads with recents. */
export function getRelatedPosts(
  posts: BlogPost[],
  current: BlogPost,
  limit = 3,
): BlogPost[] {
  const others = posts.filter((p) => p.url !== current.url);
  const shared = others.filter((p) =>
    p.data.tags.some((t) => current.data.tags.includes(t)),
  );
  const rest = others.filter((p) => !shared.includes(p));
  return [...shared, ...rest].slice(0, limit);
}

export function formatPostDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/** ~230 wpm over the raw MDX source, floored at 1 minute. */
export async function getReadingMinutes(post: BlogPost): Promise<number> {
  const raw = await post.data.getText("raw");
  const words = raw.split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 230));
}
