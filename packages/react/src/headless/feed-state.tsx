"use client";

/**
 * `<FeedStateProvider>` — renderless render-prop exposing the headless feed API
 * ({@link useHogsendFeed}'s full §3 return). Loop events fire in the SDK store
 * mutation, never the component — headless users can't opt out of the closed
 * loop. Optionally scope to a `feedId`.
 */

import type { FeedFetchOptions } from "@hogsend/js";
import type { ReactNode } from "react";
import {
  type UseHogsendFeed,
  useHogsendFeed,
} from "../hooks/use-hogsend-feed.js";

export interface FeedStateProviderProps {
  /** Scope to a specific feedId (else provider/default "in_app"). */
  feedId?: string;
  /** Initial fetch scope/page-size. */
  defaultFeedOptions?: FeedFetchOptions;
  /** Render-prop receiving the live headless feed state. */
  children: (state: UseHogsendFeed) => ReactNode;
}

export function FeedStateProvider({
  feedId,
  defaultFeedOptions,
  children,
}: FeedStateProviderProps): ReactNode {
  const state = useHogsendFeed({
    ...(feedId ? { feedId } : {}),
    ...(defaultFeedOptions ? { defaultFeedOptions } : {}),
  });
  return <>{children(state)}</>;
}
