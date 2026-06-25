"use client";

/**
 * `useHogsendFeed()` (alias `useInbox`) — v2 hook. The full reactive feed lands
 * in v2; v1 ships the SIGNATURE + a typed default-shaped return so the
 * NotificationBell shell can bind to `metadata.unseen_count` today (it reads
 * zeroes until v2). Mutation methods throw a clear "not implemented in v1"
 * Error. This is the headless API surface the bell renders against.
 */

import type { FeedItem, FeedMetadata, FeedPageInfo } from "@hogsend/js";
import { useContext } from "react";
import { HogsendContext } from "../provider/context.js";

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
  on: (event: "items" | "metadata", listener: () => void) => () => void;
}

const NOT_IMPLEMENTED =
  "@hogsend/react: feed mutations are not implemented in v1 (land in v2)";

const notImplemented = async (): Promise<never> => {
  throw new Error(NOT_IMPLEMENTED);
};

const markNotImplemented = async (_ids: string[]): Promise<never> => {
  throw new Error(NOT_IMPLEMENTED);
};

/**
 * v2 feed hook (stub). Signature complete; reads return empty defaults; writes
 * throw until v2 wires the feed backend. Must be used within a provider.
 */
export function useHogsendFeed(): UseHogsendFeed {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useHogsendFeed must be used within <HogsendProvider>");
  }
  return {
    items: [],
    pageInfo: EMPTY_PAGE_INFO,
    metadata: EMPTY_METADATA,
    loading: false,
    networkStatus: "ready",
    fetch: notImplemented,
    fetchNextPage: notImplemented,
    refetch: notImplemented,
    markAsSeen: markNotImplemented,
    markAsRead: markNotImplemented,
    markAsArchived: markNotImplemented,
    markAsUnseen: markNotImplemented,
    markAsUnread: markNotImplemented,
    markAllAsSeen: notImplemented,
    markAllAsRead: notImplemented,
    markAllAsArchived: notImplemented,
    on: () => () => {},
  };
}

/** Knock-parity alias. */
export const useInbox = useHogsendFeed;
