"use client";

import { type JSX, useEffect, useRef } from "react";
import { getAnonymousDistinctId } from "@/lib/analytics";

/**
 * Fires the server-side `referral.visited` event once per mount, and ONLY when
 * a `?ref` token is present. Unlike ReferralViewPing (a PostHog-only analytics
 * ping via `capture()`), this hits the docs `/api/referral-visited` route,
 * which holds the ingest key and forwards into the dogfood front door so the
 * conversion (Discord /link) can be attributed to the referrer.
 *
 * PRIVACY: only the opaque `ref` and the visitor's PostHog distinct_id leave
 * the browser — the friend's display name from /hey/[name] never reaches this
 * component (it isn't passed in) and never reaches the wire.
 */
export function ReferralVisitedPing({
  refKey,
}: {
  refKey: string | null;
}): JSX.Element | null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current || !refKey) return;
    fired.current = true;

    // Read the anon id BEFORE any navigation; the route maps it to top-level
    // `anonymousId` so the visit lands on the visitor's PostHog person.
    // IDENTIFIED sessions return undefined and are skipped entirely: their
    // distinct_id is the Hogsend contact key, and ingesting it as an
    // anonymousId minted a phantom contact carrying a real contact's key.
    // Referral attribution is an anonymous top-of-funnel signal anyway — a
    // visitor we already know isn't a referred prospect.
    const anonymousId = getAnonymousDistinctId();
    if (!anonymousId) return;

    fetch("/api/referral-visited", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ref: refKey, anonymousId }),
      // Fire-and-forget: never block the page; tolerate the visitor leaving.
      keepalive: true,
    }).catch(() => {});
  }, [refKey]);

  return null;
}
