"use client";

import posthog from "posthog-js";
import { type JSX, useEffect } from "react";
import { DURABLE_PERSISTENCE, hasConsented } from "@/lib/analytics";

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
  // A returning visitor who already consented boots straight into durable
  // persistence — no fork at the consent boundary on later visits. A fresh
  // visitor boots strictly cookieless ("memory") until they consent (MF-8);
  // the upgrade then happens via set_config without a re-init.
  const persistence = hasConsented() ? DURABLE_PERSISTENCE : "memory";

  posthog.init(posthogKey, {
    // First-party reverse proxy (Next rewrite in next.config.mjs) so ad blockers
    // can't sever ingestion — `/relay/*` is same-origin and proxies to PostHog
    // EU. `ui_host` still points at the real PostHog UI so the toolbar and
    // session links resolve. `api_host` is a relative path: the browser resolves
    // it against the current origin, which is exactly the first-party host we want.
    api_host: "/relay",
    ui_host: "https://eu.posthog.com",
    // Strictly cookieless ("memory") until explicit consent, then upgraded to
    // localStorage+cookie so the visitor is durably ONE person across page
    // loads. Pre-consent the anon id regenerates each full load (session-scoped
    // by design); post-consent it is stable (zero further merges).
    persistence,
    // Scope the post-consent distinct_id cookie to `.hogsend.com` (not the bare
    // host) so other Hogsend subdomains — notably the cold-connect connect page
    // served off the API host — can read this visitor's existing id and fold
    // their prior anonymous browsing into the proven identity. This is INIT-only
    // config: it sets the cookie DOMAIN but never forces a write, so pre-consent
    // ("memory" persistence) still writes no cookie at all. The durable cookie
    // appears only once persistence upgrades to localStorage+cookie at consent —
    // the consent gate above is untouched.
    cross_subdomain_cookie: true,
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
  // Hogsend URL in the client) along with this session's own anon distinct id
  // (`currentDistinctId`) — the engine performs a server-side `alias`, folding
  // this session into the token's canonical person. That alias is the DURABLE
  // stitch (immune to browser persistence resets); the client `identify` below
  // is now only a same-session convenience. The token is stripped from the
  // address bar so it never lingers in history or shares.
  const params = new URLSearchParams(window.location.search);
  const identityToken = params.get("hs_t");
  if (identityToken) {
    params.delete("hs_t");
    const cleaned =
      window.location.pathname +
      (params.size > 0 ? `?${params.toString()}` : "") +
      window.location.hash;
    window.history.replaceState(window.history.state, "", cleaned);

    const currentDistinctId = posthog.get_distinct_id();
    void fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token: identityToken,
        ...(currentDistinctId ? { currentDistinctId } : {}),
      }),
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
 * Boots strictly cookieless ("memory") until the visitor explicitly consents
 * (the required terms checkbox in EmailCapture), then upgrades to durable
 * localStorage+cookie persistence via `set_config` — so no pre-consent
 * cookie/localStorage write, and one stable person from consent forward.
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
