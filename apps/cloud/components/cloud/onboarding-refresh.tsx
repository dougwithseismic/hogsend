"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * How often an unfinished checklist re-reads the server.
 *
 * A minute, not fifteen seconds, because a refresh is NOT cheap: it re-runs the
 * whole server page, including a live HTTP call to the tenant instance for its
 * key list. The signals this waits on — a stack going healthy, a first publish
 * landing — take minutes, so a faster poll buys nothing and bills the tenant a
 * request for it.
 */
export const ONBOARDING_REFRESH_MS = 60_000;

/**
 * Re-renders the page while the checklist is still unfinished.
 *
 * A poll rather than a socket, deliberately. The events this watches for —
 * a publish, a first send — arrive minutes apart at best, so a persistent
 * connection per viewer would buy latency nobody is waiting on and cost an
 * always-open connection per open tab.
 *
 * It is mounted BY the checklist, and only while a refresh could change
 * something — see `worthRefreshing`. The counter-backed steps are written by a
 * nightly cron, so once the live steps are done there is nothing a poll can
 * reveal. There is no "should I still be running" check here for that reason:
 * not rendering the component IS the check.
 *
 * `router.refresh()` re-runs the server components in place — no navigation,
 * no lost scroll position, no flash, and no client-side data layer to keep in
 * step with the server's.
 */
export function OnboardingRefresh(): null {
  const router = useRouter();

  useEffect(() => {
    // Pause while the tab is hidden. A backgrounded dashboard polling every
    // fifteen seconds is pure waste, and the refresh on becoming visible again
    // is the one that actually matters.
    const tick = () => {
      if (document.visibilityState === "visible") router.refresh();
    };

    const timer = setInterval(tick, ONBOARDING_REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [router]);

  return null;
}
