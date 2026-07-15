"use client";

import posthog from "posthog-js";
import { useEffect, useState } from "react";

/**
 * PostHog feature flags — the runtime kill-switches for surfaces we can ship
 * dark and reveal to a targeted audience without a deploy. Flag names live here
 * as the single source of truth (mirroring the `AnalyticsEvent` enum), so a
 * component reads `FeatureFlag.X` instead of a stray string literal.
 *
 * Naming: `context-object-state`, kebab-case — the same value is what you type
 * into the PostHog "Feature flags" UI, so keep them identical.
 */
export const FeatureFlag = {
  /**
   * Self-serve Stripe Checkout for the paid service tiers (Managed instance,
   * Setup week). OFF by default: with no fulfilment pipeline behind it yet, the
   * paid CTAs fall back to "reach out to hello@hogsend.com". The "book a call"
   * (Done-for-you) path is NOT gated by this — it stays live for all visitors.
   *
   * To preview the real checkout as just yourself before opening it up: use the
   * PostHog Toolbar's feature-flag override (per-browser, and immune to this
   * app's cookieless rotating anon id — the simplest path), OR accept the cookie
   * banner once (that upgrades PostHog to a durable distinct_id) and add a
   * release condition targeting that id. A blanket percentage rollout is NOT a
   * reliable way to target only yourself here: pre-consent visitors get a fresh
   * anon id each load, so the rollout bucket — and the CTA — would flicker
   * between reloads.
   */
  SELF_SERVE_CHECKOUT: "service-self-serve-checkout",
} as const;

export type FeatureFlagName = (typeof FeatureFlag)[keyof typeof FeatureFlag];

/**
 * useFeatureFlag — reactive boolean for a PostHog feature flag, resolved
 * client-side against the current (possibly anonymous, possibly identified)
 * PostHog person.
 *
 * Returns `false` until flags have loaded — a deliberate fail-safe default so a
 * gated surface renders its OFF branch during SSR/hydration and while PostHog
 * boots (the key is fetched at runtime in `PosthogBoot`, so flags arrive a beat
 * after mount). `onFeatureFlags` registered on the singleton persists across
 * that async init and fires once flags land, flipping us to the real value.
 */
export function useFeatureFlag(flag: FeatureFlagName): boolean {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    const sync = (): void => {
      if (!active) return;
      // isFeatureEnabled returns undefined before flags load — coerce to false.
      setEnabled(posthog.isFeatureEnabled(flag) === true);
    };

    // Fires after flags are (re)loaded, covering the async runtime boot; the
    // callback is queued on the singleton even if registered pre-init.
    const unsubscribe = posthog.onFeatureFlags(() => sync());
    // Cover the case where flags were already loaded before this mount.
    sync();

    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [flag]);

  return enabled;
}
