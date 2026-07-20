"use client";

import { useHogsend } from "@hogsend/react";
import { type JSX, type ReactNode, useEffect, useRef } from "react";
import { isHogsendConfigured } from "@/components/hogsend/config";
import { AnalyticsEvent, capture } from "@/lib/analytics";

/**
 * Playbook reading events — the dogfood intent signal. Each event fires two
 * legs: the anonymous PostHog capture (insights) and, when the Hogsend
 * provider is configured, the docs' own Hogsend client (`hs_anon_id`, or the
 * signed-in contact), so which plays a visitor reads lands in the dogfood
 * ingest. Both legs use the same event name, matching TrackDemoClick.
 */

type PlayProps = { slug: string; category: string };

/** Fires one `docs.play_viewed` per play open, mounted on the play page. */
export function PlayViewTracker({ slug, category }: PlayProps): JSX.Element {
  // Build-time constant split: `useHogsend` throws outside HogsendProvider,
  // which only mounts when isHogsendConfigured.
  if (!isHogsendConfigured) {
    return <PosthogViewLeg slug={slug} category={category} />;
  }
  return <DualViewLeg slug={slug} category={category} />;
}

function PosthogViewLeg({ slug, category }: PlayProps): JSX.Element | null {
  useViewEffect(slug, () => {
    capture(AnalyticsEvent.PLAY_VIEWED, { slug, category });
  });
  return null;
}

function DualViewLeg({ slug, category }: PlayProps): JSX.Element | null {
  const { capture: hogsendCapture } = useHogsend();
  useViewEffect(slug, () => {
    capture(AnalyticsEvent.PLAY_VIEWED, { slug, category });
    hogsendCapture(AnalyticsEvent.PLAY_VIEWED, { slug, category });
  });
  return null;
}

/** Once per mounted slug — client-side nav between plays remounts the page,
 * but StrictMode double-effects must not double-fire. */
function useViewEffect(slug: string, fire: () => void): void {
  const tracked = useRef<string | null>(null);
  useEffect(() => {
    if (tracked.current === slug) return;
    tracked.current = slug;
    fire();
  }, [slug, fire]);
}

type CtaProps = {
  rung: "self-serve" | "audit" | "dfy";
  slug: string;
  children: ReactNode;
};

/** Wraps a ladder-CTA rung; a click fires `docs.play_cta_clicked` dual-leg. */
export function TrackPlayCta({ rung, slug, children }: CtaProps): JSX.Element {
  if (!isHogsendConfigured) {
    return (
      <span
        style={{ display: "contents" }}
        onClickCapture={() =>
          capture(AnalyticsEvent.PLAY_CTA_CLICKED, { rung, slug })
        }
      >
        {children}
      </span>
    );
  }
  return (
    <DualCtaLeg rung={rung} slug={slug}>
      {children}
    </DualCtaLeg>
  );
}

function DualCtaLeg({ rung, slug, children }: CtaProps): JSX.Element {
  const { capture: hogsendCapture } = useHogsend();
  return (
    <span
      style={{ display: "contents" }}
      onClickCapture={() => {
        capture(AnalyticsEvent.PLAY_CTA_CLICKED, { rung, slug });
        hogsendCapture(AnalyticsEvent.PLAY_CTA_CLICKED, { rung, slug });
      }}
    >
      {children}
    </span>
  );
}
