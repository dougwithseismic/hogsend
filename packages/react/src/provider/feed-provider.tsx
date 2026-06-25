"use client";

/**
 * `<HogsendFeedProvider>` — scopes a subtree to a specific `feedId` and default
 * fetch options so descendant `useHogsendFeed()`/`<NotificationBell>`/feed
 * components read the same feed without each passing `feedId` (plan §3). The
 * context value is a STABLE reference (memoized) — feed DATA flows through the
 * external store, never context, so this provider never churns consumers.
 *
 * Optional: `useHogsendFeed()` works WITHOUT this provider (it falls back to the
 * SDK default feedId "in_app"). This provider is for multi-feed apps or to set
 * a default fetch scope once.
 */

import type { FeedFetchOptions } from "@hogsend/js";
import { type ReactNode, useMemo } from "react";
import {
  HogsendFeedContext,
  type HogsendFeedContextValue,
} from "./feed-context.js";

/** Props for {@link HogsendFeedProvider}. */
export interface HogsendFeedProviderProps {
  /** The feed bucket id (engine `category`). Default "in_app". */
  feedId?: string;
  /** Default fetch scope/page-size for descendant feed hooks. */
  defaultFeedOptions?: FeedFetchOptions;
  children: ReactNode;
}

export function HogsendFeedProvider({
  feedId = "in_app",
  defaultFeedOptions,
  children,
}: HogsendFeedProviderProps): ReactNode {
  // Stabilize the default-options reference by its scalar contents so a fresh
  // inline object prop doesn't churn the context every render — re-derive only
  // when the serialized contents change.
  const optsKey = defaultFeedOptions ? JSON.stringify(defaultFeedOptions) : "";
  const stableOptions = useMemo<FeedFetchOptions | undefined>(
    () => (optsKey ? (JSON.parse(optsKey) as FeedFetchOptions) : undefined),
    [optsKey],
  );
  const value = useMemo<HogsendFeedContextValue>(
    () => ({
      feedId,
      ...(stableOptions ? { defaultFeedOptions: stableOptions } : {}),
    }),
    [feedId, stableOptions],
  );

  return (
    <HogsendFeedContext.Provider value={value}>
      {children}
    </HogsendFeedContext.Provider>
  );
}
