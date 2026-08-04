"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** How often an unfinished checklist re-reads the server. */
export const ONBOARDING_REFRESH_MS = 15_000;

/**
 * Re-renders the page while the checklist is still unfinished.
 *
 * A poll rather than a socket, deliberately. The events this watches for —
 * a publish, a first send — arrive minutes apart at best, so a persistent
 * connection per viewer would buy latency nobody is waiting on and cost an
 * always-open connection per open tab.
 *
 * It is mounted BY the checklist, so it exists only while there is something
 * left to tick: the last box ticking unmounts the panel, which stops the poll.
 * There is no "am I done" check here for that reason.
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
