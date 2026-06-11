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

  // Cross-device stitch: a visitor arriving from a tracked email link carries
  // a short-lived signed `hs_t` token. Exchange it (server-side proxy, no
  // Hogsend URL in the client) for the distinct id and identify the session —
  // the email click and this web session become one PostHog person. Memory
  // persistence keeps the merge session-scoped: nothing is written to the
  // device, matching the site's cookieless posture. The token is stripped
  // from the address bar so it never lingers in history or shares.
  const params = new URLSearchParams(window.location.search);
  const identityToken = params.get("hs_t");
  if (identityToken) {
    params.delete("hs_t");
    const cleaned =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "") +
      window.location.hash;
    window.history.replaceState(window.history.state, "", cleaned);

    void fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: identityToken }),
    })
      .then(async (res) => {
        if (!res.ok) return;
        const { distinctId } = (await res.json()) as { distinctId?: string };
        if (distinctId) posthog.identify(distinctId);
      })
      .catch(() => {
        // Best-effort: an expired or invalid token simply means no stitch.
      });
  }
}
