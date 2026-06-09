import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

/** AI crawlers we explicitly welcome (paired with /llms.txt). */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-Web",
  "anthropic-ai",
  "PerplexityBot",
  "Google-Extended",
];

/**
 * Robots: block everything outside the production deploy (previews, PR
 * environments, local builds) so only hogsend.com gets indexed.
 */
export default function robots(): MetadataRoute.Robots {
  const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME;
  const isProduction =
    process.env.NODE_ENV === "production" &&
    (railwayEnv === undefined || railwayEnv === "production");

  if (!isProduction) {
    return { rules: [{ userAgent: "*", disallow: "/" }] };
  }

  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: ["/api/"] },
      ...AI_CRAWLERS.map((ua) => ({ userAgent: ua, allow: "/" })),
    ],
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
