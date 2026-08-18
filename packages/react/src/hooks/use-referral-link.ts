"use client";

/**
 * `useReferralLink()`: the signed-in user's own share link and counts, read
 * reactively from the SDK's `referral` slice (mirrors `useFlags`/`useGroup`).
 *
 * Unlike the flags slice, the SDK does NOT fetch this on init: the route is
 * gated on a server-minted `userToken`, so an anonymous page load has nothing
 * to ask for. This hook therefore triggers the fetch itself, once per
 * (userToken, referral) pair, and never on the server.
 *
 * `link`/`stats` stay null for an anonymous session and for a token the engine
 * does not accept: `GET /v1/referrals/me` is NON-CONFIRMING, so "no referral
 * registered", "forged token" and "unknown user" are one answer. Nothing here
 * throws on a failed fetch.
 *
 * SELECTOR RULE: it selects the SLICE OBJECT (a stable reference written by
 * the SDK), then destructures outside the selector. Building `{ link, stats }`
 * inside would make `useSyncExternalStore` loop.
 */

import type { ReferralLink, ReferralStats } from "@hogsend/js";
import { useContext, useEffect } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

/** Options for {@link useReferralLink}. */
export interface UseReferralLinkOptions {
  /** The `defineReferral` id. Default `"default"` server-side. */
  referral?: string;
}

/** What {@link useReferralLink} returns. */
export interface UseReferralLink {
  /** The caller's share link, or null (anonymous / not accepted / no program). */
  link: ReferralLink | null;
  /** The caller's own touched/bound/qualified counts, or null. */
  stats: ReferralStats | null;
  /** True while the first (or a re-)fetch is in flight. */
  loading: boolean;
  /** Re-fetch on demand (after a share, say). Never rejects. */
  refresh: () => void;
}

const EMPTY = { link: null, stats: null, loading: false } as const;

/**
 * Subscribe to the caller's referral link. Must be used within
 * `<HogsendProvider>`.
 */
export function useReferralLink(
  opts: UseReferralLinkOptions = {},
): UseReferralLink {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useReferralLink must be used within <HogsendProvider>");
  }
  const client = ctx.client;
  const referral = opts.referral;

  const slice = useStoreSelector(client.store, (s) => s.referral ?? EMPTY);

  // Fetch on mount, then re-fetch whenever the bound identity flips (the SDK
  // clears the slice on that flip, so the previous user's link is never shown
  // while the re-fetch is in flight). Effect-only: never runs during SSR.
  useEffect(() => {
    const fetchLink = () => {
      void client.referral.link(referral ? { referral } : {});
    };
    let lastDistinctId = client.getDistinctId();
    fetchLink();
    return client.store.subscribe(() => {
      const next = client.getDistinctId();
      if (next === lastDistinctId) return;
      lastDistinctId = next;
      fetchLink();
    });
  }, [client, referral]);

  return {
    link: slice.link,
    stats: slice.stats,
    loading: slice.loading,
    refresh: () => {
      void client.referral.link(referral ? { referral } : {});
    },
  };
}
