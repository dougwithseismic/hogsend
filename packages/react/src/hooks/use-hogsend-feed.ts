"use client";

/**
 * `useHogsendFeed()` (alias `useInbox`) — the v2 reactive feed hook. It binds to
 * the feed-store SLICE (`feeds[feedId]`) via `useStoreSelector`, derives the
 * `items[]` array OUTSIDE the selector from the stable `order`/`byId` pair (the
 * infinite-loop guard, plan §7), and delegates every mutation to the SDK feed
 * client — so the `inapp.*` closed-loop emission lives in the client STORE
 * mutation, not here. Realtime (poll default) is opened in an effect and torn
 * down on unmount, strict-mode-double-invoke-safe (the client's `connect()` is
 * idempotent per feedId and `teardown()` runs once on provider unmount).
 *
 * The selected `feedId` comes from {@link HogsendFeedContext} (set by
 * `<HogsendFeedProvider>`) and falls back to the SDK default `"in_app"`.
 */

import type {
  FeedClient,
  FeedFetchOptions,
  FeedItem,
  FeedMetadata,
  FeedPageInfo,
  Hogsend,
  HogsendState,
  Store,
} from "@hogsend/js";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { HogsendContext } from "../provider/context.js";
import { HogsendFeedContext } from "../provider/feed-context.js";
import { useStoreSelector } from "./use-store.js";

const DEFAULT_FEED_ID = "in_app";

const EMPTY_METADATA: FeedMetadata = {
  total_count: 0,
  unseen_count: 0,
  unread_count: 0,
};

const EMPTY_PAGE_INFO: FeedPageInfo = {
  before: null,
  after: null,
  hasNextPage: false,
};

const EMPTY_ORDER: string[] = [];
const EMPTY_BY_ID: Record<string, FeedItem> = {};

/** Network status of the feed (mirrors Knock's `networkStatus`). */
export type FeedNetworkStatus = "loading" | "fetchMore" | "ready" | "error";

/** Return shape of {@link useHogsendFeed}. */
export interface UseHogsendFeed {
  items: FeedItem[];
  pageInfo: FeedPageInfo;
  metadata: FeedMetadata;
  loading: boolean;
  networkStatus: FeedNetworkStatus;
  fetch: () => Promise<void>;
  fetchNextPage: () => Promise<void>;
  refetch: () => Promise<void>;
  markAsSeen: (ids: string[]) => Promise<void>;
  markAsRead: (ids: string[]) => Promise<void>;
  markAsArchived: (ids: string[]) => Promise<void>;
  markAsUnseen: (ids: string[]) => Promise<void>;
  markAsUnread: (ids: string[]) => Promise<void>;
  markAllAsSeen: () => Promise<void>;
  markAllAsRead: () => Promise<void>;
  markAllAsArchived: () => Promise<void>;
  /** Subscribe to realtime item/metadata updates (delegates to the client). */
  on: (event: "items" | "metadata", listener: () => void) => () => void;
  /** The reactive store the feed slice lives in (for advanced selectors). */
  store: Store<HogsendState>;
}

/** Options accepted by {@link useHogsendFeed}. */
export interface UseHogsendFeedOptions {
  /** Override the context feedId for this hook instance. */
  feedId?: string;
  /** Initial fetch scope/page-size (forwarded to `client.feed(feedId, opts)`). */
  defaultFeedOptions?: FeedFetchOptions;
}

/** Build the `items[]` array from a stable slice — NEVER inside a selector. */
function deriveItems(
  order: string[],
  byId: Record<string, FeedItem>,
): FeedItem[] {
  const out: FeedItem[] = [];
  for (const id of order) {
    const item = byId[id];
    if (item) out.push(item);
  }
  return out;
}

/**
 * The v2 feed hook. Reads the feed slice reactively, derives `items` from the
 * stable `order`/`byId` pair, and exposes the full Knock-parity mutation
 * surface. Must be used within `<HogsendProvider>`.
 */
export function useHogsendFeed(
  options?: UseHogsendFeedOptions,
): UseHogsendFeed {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useHogsendFeed must be used within <HogsendProvider>");
  }
  const feedCtx = useContext(HogsendFeedContext);

  const client = ctx.client;
  const feedId = options?.feedId ?? feedCtx?.feedId ?? DEFAULT_FEED_ID;
  const defaultFeedOptions =
    options?.defaultFeedOptions ?? feedCtx?.defaultFeedOptions;

  // `defaultFeedOptions` only matters the FIRST time `client.feed(feedId)` is
  // constructed (the SDK caches one feed client per feedId). Pin it in a ref so
  // the feed-client memo legitimately depends only on `[client, feedId]` — a
  // fresh inline options object never re-runs it.
  const defaultOptsRef = useRef(defaultFeedOptions);

  // One feed client per feedId (the SDK caches it, so this is stable across
  // renders); also drives the realtime connect effect.
  const feed: FeedClient = useMemo(
    () => client.feed(feedId, defaultOptsRef.current),
    [client, feedId],
  );

  // ── reactive slice binding (stable references only) ──
  const order = useStoreSelector<HogsendState, string[]>(
    client.store,
    (s) => s.feeds?.[feedId]?.order ?? EMPTY_ORDER,
  );
  const byId = useStoreSelector<HogsendState, Record<string, FeedItem>>(
    client.store,
    (s) => s.feeds?.[feedId]?.byId ?? EMPTY_BY_ID,
  );
  const pageInfo = useStoreSelector<HogsendState, FeedPageInfo>(
    client.store,
    (s) => s.feeds?.[feedId]?.pageInfo ?? EMPTY_PAGE_INFO,
  );
  const metadata = useStoreSelector<HogsendState, FeedMetadata>(
    client.store,
    (s) => s.feeds?.[feedId]?.metadata ?? EMPTY_METADATA,
  );

  // Derive items OUTSIDE the selector from the two stable references; memoize
  // so a render that didn't change order/byId yields the same array reference.
  const items = useMemo(() => deriveItems(order, byId), [order, byId]);

  // ── network status ──
  const [networkStatus, setNetworkStatus] =
    useState<FeedNetworkStatus>("loading");
  const loading = networkStatus === "loading";

  const fetch = useCallback(async () => {
    setNetworkStatus("loading");
    try {
      await feed.fetch();
      setNetworkStatus("ready");
    } catch {
      setNetworkStatus("error");
    }
  }, [feed]);

  const fetchNextPage = useCallback(async () => {
    setNetworkStatus("fetchMore");
    try {
      await feed.fetchNextPage();
      setNetworkStatus("ready");
    } catch {
      setNetworkStatus("error");
    }
  }, [feed]);

  const refetch = useCallback(async () => {
    try {
      await feed.refetch();
      setNetworkStatus("ready");
    } catch {
      setNetworkStatus("error");
    }
  }, [feed]);

  // ── initial fetch + realtime (poll) connect, torn down on unmount ──
  // Re-runs when the feed (feedId) changes. The client's `connect()` is
  // idempotent per feedId, so strict-mode's double-invoke is a no-op; teardown
  // of the realtime channel happens in the provider's `teardown()` on unmount.
  const didInitialFetch = useRef<string | null>(null);
  useEffect(() => {
    let active = true;
    if (didInitialFetch.current !== feedId) {
      didInitialFetch.current = feedId;
      setNetworkStatus("loading");
      feed
        .fetch()
        .then(() => {
          if (active) setNetworkStatus("ready");
        })
        .catch(() => {
          if (active) setNetworkStatus("error");
        });
    }
    // Open the realtime transport (poll default) for this feedId.
    client.connect(feedId);
    return () => {
      active = false;
    };
  }, [client, feed, feedId]);

  // Mark methods delegate straight to the client (loop emission lives there).
  const markAsSeen = useCallback(
    (ids: string[]) => feed.markAsSeen(ids),
    [feed],
  );
  const markAsRead = useCallback(
    (ids: string[]) => feed.markAsRead(ids),
    [feed],
  );
  const markAsArchived = useCallback(
    (ids: string[]) => feed.markAsArchived(ids),
    [feed],
  );
  const markAsUnseen = useCallback(
    (ids: string[]) => feed.markAsUnseen(ids),
    [feed],
  );
  const markAsUnread = useCallback(
    (ids: string[]) => feed.markAsUnread(ids),
    [feed],
  );
  const markAllAsSeen = useCallback(() => feed.markAllAsSeen(), [feed]);
  const markAllAsRead = useCallback(() => feed.markAllAsRead(), [feed]);
  const markAllAsArchived = useCallback(() => feed.markAllAsArchived(), [feed]);
  const on = useCallback(
    (event: "items" | "metadata", listener: () => void) =>
      feed.on(event, listener),
    [feed],
  );

  return {
    items,
    pageInfo,
    metadata,
    loading,
    networkStatus,
    fetch,
    fetchNextPage,
    refetch,
    markAsSeen,
    markAsRead,
    markAsArchived,
    markAsUnseen,
    markAsUnread,
    markAllAsSeen,
    markAllAsRead,
    markAllAsArchived,
    on,
    store: client.store,
  };
}

/** Knock-parity alias. */
export const useInbox = useHogsendFeed;

/** Re-export for consumers building custom mark wiring against the SDK type. */
export type { Hogsend };
