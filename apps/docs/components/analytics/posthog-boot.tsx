"use client";

import posthog from "posthog-js";
import { type JSX, useEffect } from "react";

/**
 * Replace the name segment of any /hey/<name> URL with /hey/_ in strings,
 * recursing through nested objects/arrays — PostHog nests $initial_current_url
 * et al. inside $set_once on person-profile events.
 */
const scrubHeyUrls = (value: unknown): unknown => {
  if (typeof value === "string") {
    return value.replace(/\/hey\/[^/?#]+/g, "/hey/_");
  }
  if (Array.isArray(value)) {
    return value.map(scrubHeyUrls);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [key, scrubHeyUrls(v)]),
    );
  }
  return value;
};

function boot(posthogKey: string): void {
  posthog.init(posthogKey, {
    api_host: "https://eu.i.posthog.com",
    persistence: "memory",
    capture_pageview: true,
    capture_pageleave: true,
    // /hey/<name> referral pages carry a first name in the URL. PostHog gets
    // zero PII, so every string property ($current_url, $pathname, $referrer,
    // $initial_*…) is scrubbed before send — recursively, since the
    // $initial_* values travel nested inside $set_once.
    sanitize_properties: (properties) =>
      scrubHeyUrls(properties) as typeof properties,
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

/**
 * PosthogBoot — boots PostHog with a key fetched from `/api/posthog-config`
 * (a force-dynamic handler reading the server's RUNTIME env). This replaces
 * the old `instrumentation-client.ts`, which inlined
 * `NEXT_PUBLIC_POSTHOG_KEY` at BUILD time — fragile on Railway, where a
 * build that misses the build-arg ships a silently analytics-dead bundle.
 * (A layout-prop read is no better: static pages freeze the layout's RSC
 * output at build.) Runtime fetch means: change the variable, restart, done.
 *
 * Memory persistence keeps it strictly cookieless (nothing written to
 * cookies or localStorage), so no consent banner is needed.
 */
export function PosthogBoot(): JSX.Element | null {
  useEffect(() => {
    if (posthog.__loaded) return;
    let cancelled = false;

    void fetch("/api/posthog-config")
      .then(async (res) => (res.ok ? res.json() : { key: null }))
      .then(({ key }: { key: string | null }) => {
        if (cancelled || !key || posthog.__loaded) return;
        boot(key);
      })
      .catch(() => {
        // Best-effort: no config endpoint, no analytics.
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return null;
}
