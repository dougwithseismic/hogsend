"use client";

import type { JSX, ReactNode } from "react";
import {
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
