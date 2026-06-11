"use client";

import { type JSX, useEffect, useRef } from "react";
import { AnalyticsEvent, capture } from "@/lib/analytics";

/**
 * Fires the distinct referral page-view event once per mount. The name from
 * the URL never reaches PostHog — only whether the page was personalised.
 */
export function ReferralViewPing({
  personalised,
}: {
  personalised: boolean;
}): JSX.Element | null {
  const fired = useRef(false);

  useEffect(() => {
    if (fired.current) return;
    fired.current = true;
    capture(AnalyticsEvent.REFERRAL_VIEWED, { personalised });
  }, [personalised]);

  return null;
}
