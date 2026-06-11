import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

const { GET: search } = createFromSource(source, {
  language: "english",
});

const MIN_QUERY_LENGTH = 3;
const MAX_QUERY_LENGTH = 120;

/**
 * trackSearch — fire-and-forget server-side capture of docs searches. What
 * people search for is a literal list of what they can't find. The site's
 * client-side PostHog is cookieless, so there's no per-person distinct_id to
 * thread through here — all searches land on one shared anonymous id, which
 * is fine: this event is only ever read in aggregate, grouped by `query`.
 * Search-as-you-type means prefixes ("eve", "even", "event") land too;
 * filter by length or trailing word in insights.
 */
function trackSearch(request: Request): void {
  const key = process.env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key) return;

  const query = new URL(request.url).searchParams.get("query")?.trim();
  if (!query || query.length < MIN_QUERY_LENGTH) return;

  fetch("https://eu.i.posthog.com/capture/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      api_key: key,
      event: "docs.search_performed",
      distinct_id: "docs-search-anonymous",
      properties: { query: query.slice(0, MAX_QUERY_LENGTH) },
    }),
  }).catch(() => {});
}

export async function GET(request: Request): Promise<Response> {
  trackSearch(request);
  return search(request);
}
