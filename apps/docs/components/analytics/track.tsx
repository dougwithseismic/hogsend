"use client";

import { useHogsend } from "@hogsend/react";
import type { JSX, ReactNode } from "react";
import { isHogsendConfigured } from "@/components/hogsend/config";
import {
  AnalyticsEvent,
  type AnalyticsEventName,
  capture,
  trackDeployClick,
} from "@/lib/analytics";

/**
 * TrackClick — wraps any server-rendered link/button and captures a PostHog
 * event when it's clicked. `display: contents` keeps the wrapper out of
 * layout; props must stay serializable so server components can use it.
 */
export function TrackClick({
  event,
  properties,
  children,
}: {
  event: AnalyticsEventName;
  properties?: Record<string, unknown>;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      style={{ display: "contents" }}
      onClickCapture={() => capture(event, properties)}
    >
      {children}
    </span>
  );
}

/**
 * TrackDeployClick — deploy CTAs get their own wrapper because a deploy
 * click is the activation event: besides the anonymous PostHog capture it
 * forwards `docs.deploy_clicked` to the Hogsend ingest API when the visitor
 * subscribed earlier in this session (see trackDeployClick).
 */
export function TrackDeployClick({
  placement,
  children,
}: {
  placement: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <span
      style={{ display: "contents" }}
      onClickCapture={() => trackDeployClick(placement)}
    >
      {children}
    </span>
  );
}

/**
 * TrackDemoClick — every link to the hosted Studio demo (demo.hogsend.com)
 * goes through this wrapper. Besides the anonymous PostHog capture it fires
 * the same `docs.demo_link_clicked` through the docs' own Hogsend client, so
 * the click lands in the dogfood ingest on the visitor's contact — the
 * anonymous `hs_anon_id`, or the signed-in contact when identified.
 */
export function TrackDemoClick({
  placement,
  children,
}: {
  placement: string;
  children: ReactNode;
}): JSX.Element {
  // Build-time constant: without the Hogsend provider (a build missing the
  // NEXT_PUBLIC vars) only the PostHog leg fires.
  if (!isHogsendConfigured) {
    return (
      <TrackClick
        event={AnalyticsEvent.DEMO_LINK_CLICKED}
        properties={{ placement }}
      >
        {children}
      </TrackClick>
    );
  }
  return <HogsendDemoClick placement={placement}>{children}</HogsendDemoClick>;
}

/** The configured leg lives in its own component because `useHogsend` throws
 * outside `HogsendProvider`, which only mounts when isHogsendConfigured. */
function HogsendDemoClick({
  placement,
  children,
}: {
  placement: string;
  children: ReactNode;
}): JSX.Element {
  const { capture: hogsendCapture, client } = useHogsend();
  return (
    <span
      style={{ display: "contents" }}
      onClickCapture={() => {
        capture(AnalyticsEvent.DEMO_LINK_CLICKED, { placement });
        hogsendCapture(AnalyticsEvent.DEMO_LINK_CLICKED, { placement });
        // The demo opens in a new tab — no unload flush will fire here, so
        // push the queued event out now. Fire-and-forget.
        void client.flush();
      }}
    >
      {children}
    </span>
  );
}

/**
 * DeployOnRailway — the tracked Railway deploy button for MDX pages
 * (registered in getMDXComponents). Mirrors the raw button markup the docs
 * used inline, with the deploy-click capture attached.
 */
export function DeployOnRailway({
  placement = "docs",
}: {
  placement?: string;
}): JSX.Element {
  return (
    <TrackDeployClick placement={placement}>
      <a
        href="https://railway.com/deploy/hogsend-posthog-audience-stack?referralCode=dougie"
        target="_blank"
        rel="noreferrer"
      >
        {/* biome-ignore lint/performance/noImgElement: external Railway button SVG, not a local asset */}
        <img
          src="https://railway.com/button.svg"
          alt="Deploy on Railway"
          height={42}
        />
      </a>
    </TrackDeployClick>
  );
}
