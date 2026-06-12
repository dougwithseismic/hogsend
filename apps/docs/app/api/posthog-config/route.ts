import { NextResponse } from "next/server";

/**
 * GET /api/posthog-config — the PostHog project key, read from the server's
 * RUNTIME env. The old `instrumentation-client.ts` inlined
 * `NEXT_PUBLIC_POSTHOG_KEY` at BUILD time, which is fragile on Railway (a
 * build that misses the build-arg ships a silently analytics-dead bundle —
 * it happened); and a layout-prop read gets frozen into prerendered static
 * pages at build just the same. A force-dynamic handler is the one place
 * env is ALWAYS read per-request: change the variable, restart, fixed.
 *
 * The project key is public by design (it ships in every PostHog snippet),
 * so serving it from an endpoint exposes nothing.
 */
export const dynamic = "force-dynamic";

export function GET(): NextResponse {
  const key = process.env.POSTHOG_KEY ?? process.env.NEXT_PUBLIC_POSTHOG_KEY;
  return NextResponse.json(
    { key: key ?? null },
    // Let the browser cache it briefly — it's one fetch per full page load
    // on a cookieless site, and the key changes ~never.
    { headers: { "Cache-Control": "public, max-age=300" } },
  );
}
