"use client";

/**
 * `<FeedStateProvider>` — renderless render-prop that exposes the headless feed
 * API. v1 ships the SHAPE so headless consumers can target a stable contract;
 * v2 fills it with live feed state. Loop events fire in the store mutation,
 * never the component — headless users can't opt out of the closed loop.
 */

import type { ReactNode } from "react";
import {
  type UseHogsendFeed,
  useHogsendFeed,
} from "../hooks/use-hogsend-feed.js";

export interface FeedStateProviderProps {
  /** Render-prop receiving the (v2-live) headless feed state. */
  children: (state: UseHogsendFeed) => ReactNode;
}

export function FeedStateProvider({
  children,
}: FeedStateProviderProps): ReactNode {
  const state = useHogsendFeed();
  return <>{children(state)}</>;
}
