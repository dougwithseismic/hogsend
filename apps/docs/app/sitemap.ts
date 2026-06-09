import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { source } from "@/lib/source";

/**
 * Sitemap: the homepage, every marketing page, and every docs page enumerated
 * from the fumadocs loader (never a hardcoded list — compare pages get a
 * higher priority because they carry the SEO comparisons).
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  const marketingPages = [
    "/pricing",
    "/emails",
    "/about",
    "/use-cases/onboarding",
    "/use-cases/trial-conversion",
    "/use-cases/winback",
    "/integrations",
    "/recipes",
  ].map((path) => ({
    url: `${SITE_URL}${path}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: 0.8,
  }));

  const docsPages = source.getPages().map((page) => ({
    url: `${SITE_URL}${page.url}`,
    lastModified: now,
    changeFrequency: "monthly" as const,
    priority: page.url.startsWith("/docs/compare") ? 0.8 : 0.5,
  }));

  return [
    {
      url: SITE_URL,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 1,
    },
    ...marketingPages,
    {
      url: `${SITE_URL}/changelog`,
      lastModified: now,
      changeFrequency: "weekly",
      priority: 0.7,
    },
    ...docsPages,
  ];
}
