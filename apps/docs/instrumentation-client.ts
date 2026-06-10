import posthog from "posthog-js";

/**
 * Client instrumentation (Next.js `instrumentation-client.ts`) — boots
 * PostHog only when NEXT_PUBLIC_POSTHOG_KEY is set. Memory persistence keeps
 * it strictly cookieless (nothing written to cookies or localStorage), so no
 * consent banner is needed. Without a key this file does nothing.
 */
const posthogKey = process.env.NEXT_PUBLIC_POSTHOG_KEY;

if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: "https://eu.i.posthog.com",
    persistence: "memory",
    capture_pageview: true,
    capture_pageleave: true,
  });
}
