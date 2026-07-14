import { POSTPHANT_ASCII } from "@/lib/postphant-ascii";
import { SITE_URL } from "@/lib/site";

/**
 * Hand-rolled robots.txt (replaces the metadata `robots.ts`): same rules,
 * plus Postphant riding on top as comment lines — an easter egg for the
 * humans who read robots.txt. Comments are ignored by crawlers, so the file
 * stays fully valid.
 */

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

const GREETING = `${POSTPHANT_ASCII.split("\n")
  .map((line) => `# ${line}`.trimEnd())
  .join("\n")}
#
# hello@hogsend.com
`;

export function GET(): Response {
  // Block everything outside the production deploy (previews, PR
  // environments, local builds) so only hogsend.com gets indexed.
  const railwayEnv = process.env.RAILWAY_ENVIRONMENT_NAME;
  const isProduction =
    process.env.NODE_ENV === "production" &&
    (railwayEnv === undefined || railwayEnv === "production");

  const rules = isProduction
    ? [
        // /hey is the personalised referral page family (bare page included)
        // — noindex via page metadata, and excluded here as belt-and-braces.
        "User-Agent: *\nAllow: /\nDisallow: /api/\nDisallow: /hey",
        ...AI_CRAWLERS.map((ua) => `User-Agent: ${ua}\nAllow: /`),
        `Sitemap: ${SITE_URL}/sitemap.xml`,
      ]
    : ["User-Agent: *\nDisallow: /"];

  return new Response(`${GREETING}\n${rules.join("\n\n")}\n`, {
    headers: { "Content-Type": "text/plain" },
  });
}
