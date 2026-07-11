import type { MetadataRoute } from "next";
import { COURSES } from "@/lib/courses";
import { isFreeLesson } from "@/lib/gating";
import { SITE_URL } from "@/lib/site";
import { source } from "@/lib/source";

/**
 * Sitemap: the catalog homepage, the public marketing pages, every course
 * overview, and every lesson enumerated from the fumadocs loader (never a
 * hardcoded list). Course overviews rank highest because they carry the
 * purchase intent; free lessons are still indexed for discovery.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  // /welcome is intentionally noindex (post-purchase landing) so it stays out
  // of the sitemap — but crawlable, so its noindex meta is honoured.
  const marketingPages = ["/pricing", "/cookies"].map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.7,
  }));

  const coursePages = COURSES.map((course) => ({
    url: `${SITE_URL}/${course.slug}`,
    lastModified: now,
    changeFrequency: "weekly" as const,
    priority: 0.9,
  }));

  // Only free lessons are indexable — gated lessons noindex (see the learn
  // route's generateMetadata), so they don't belong in the sitemap.
  const lessonPages = source
    .getPages()
    .filter((page) => isFreeLesson(page.slugs))
    .map((page) => ({
      url: `${SITE_URL}${page.url}`,
      lastModified: now,
      changeFrequency: "monthly" as const,
      priority: 0.6,
    }));

  return [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...marketingPages,
    ...coursePages,
    ...lessonPages,
  ];
}
