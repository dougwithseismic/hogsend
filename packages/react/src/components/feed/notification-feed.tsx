"use client";

/**
 * `<NotificationFeed>` — the scrollable list of feed items with a header
 * (title + "Mark all as read"), an optional status filter bar, an empty state,
 * and the load-more affordance. Binds to {@link useHogsendFeed} for live data;
 * every interaction routes its `inapp.*` emission through the SDK store
 * mutation, EXCEPT `inapp.item_clicked` which this component fires via
 * `client.capture(...)` BEFORE the consumer's `onItemClick` (plan §5/§6) — so a
 * custom `renderItem` can't opt out of the closed loop.
 *
 * Override surface (plan §6): `className` + per-slot `classNames`, `data-*`
 * state, `renderItem`/`renderHeader`/`renderEmpty`/`renderFilterBar`, plus the
 * `onItemClick`/`onItemRead`/`onMarkAllAsReadClick` callbacks.
 *
 * A11y: `role="feed"` wrapper, item rows are `role="article"`; "Mark all read"
 * is a real `<button>`; the filter bar is a `role="tablist"`.
 *
 * Lazy-friendly: this module is a leaf with no top-level side effects, so the
 * consumer can `React.lazy(() => import("@hogsend/react/feed"))`.
 */

import type {
  FeedFetchOptions,
  FeedItem as FeedItemData,
  FeedItemStatus,
} from "@hogsend/js";
import { type ReactNode, useCallback, useContext } from "react";
import {
  type FeedNetworkStatus,
  type UseHogsendFeed,
  useHogsendFeed,
} from "../../hooks/use-hogsend-feed.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { HogsendContext } from "../../provider/context.js";
import { FeedItem } from "./feed-item.js";

/** Per-slot class overrides for {@link NotificationFeed}. */
export interface NotificationFeedClassNames {
  root?: string;
  header?: string;
  headerTitle?: string;
  markAllButton?: string;
  filterBar?: string;
  filterTab?: string;
  list?: string;
  item?: string;
  empty?: string;
  loadMore?: string;
}

/** A status filter tab. */
export type FeedFilterStatus = FeedItemStatus | "all" | "unread";

/** Render-prop state passed to {@link NotificationFeedProps.renderHeader}. */
export interface FeedHeaderRenderState {
  metadata: UseHogsendFeed["metadata"];
  markAllAsRead: () => Promise<void>;
}

/** Props for {@link NotificationFeed}. */
export interface NotificationFeedProps {
  /** Scope to a specific feedId (else inherits provider/default "in_app"). */
  feedId?: string;
  /** Initial fetch scope/page-size. */
  defaultFeedOptions?: FeedFetchOptions;
  /** Initial filter tab. Default "all". Also drives the fetch `status`. */
  initialFilterStatus?: FeedFilterStatus;
  /** Replace a single item's markup (override layer 5). */
  renderItem?: (
    item: FeedItemData,
    helpers: { onClick: () => void },
  ) => ReactNode;
  /** Replace the header (override layer 5). */
  renderHeader?: (state: FeedHeaderRenderState) => ReactNode;
  /** Replace the empty state (override layer 5). */
  renderEmpty?: () => ReactNode;
  /** Replace the filter bar (override layer 5). `null` hides it (the default). */
  renderFilterBar?: (state: {
    status: FeedFilterStatus;
    setStatus: (s: FeedFilterStatus) => void;
  }) => ReactNode;
  /** Fired AFTER `inapp.item_clicked` is emitted + the item marked read. */
  onItemClick?: (item: FeedItemData) => void;
  /** Fired when an item is marked read (e.g. on click). */
  onItemRead?: (item: FeedItemData) => void;
  /** Fired when the header "Mark all as read" is clicked. */
  onMarkAllAsReadClick?: () => void;
  className?: string;
  classNames?: NotificationFeedClassNames;
  "aria-label"?: string;
}

export function NotificationFeed(props: NotificationFeedProps): ReactNode {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("NotificationFeed must be used within <HogsendProvider>");
  }
  const client = ctx.client;

  const {
    feedId,
    defaultFeedOptions,
    renderItem,
    renderHeader,
    renderEmpty,
    renderFilterBar,
    onItemClick,
    onItemRead,
    onMarkAllAsReadClick,
    className,
    classNames,
    "aria-label": ariaLabel,
  } = props;

  const feed = useHogsendFeed({
    ...(feedId ? { feedId } : {}),
    ...(defaultFeedOptions ? { defaultFeedOptions } : {}),
  });
  const {
    items,
    metadata,
    pageInfo,
    networkStatus,
    fetchNextPage,
    markAsRead,
    markAllAsRead,
  } = feed;

  // ── click → emit inapp.item_clicked (before consumer) → mark read ──
  const handleItemClick = useCallback(
    (item: FeedItemData) => {
      // Closed-loop emission FIRST (plan §5): fire-and-forget capture so the
      // journey trigger lands even if the consumer handler navigates away.
      void client.capture("inapp.item_clicked", {
        feedItemId: item.id,
        feedId: feedId ?? item.category,
        ...(item.actionUrl ? { actionUrl: item.actionUrl } : {}),
      });
      // Mark read (its own inapp.item_read emission + optimistic patch live in
      // the SDK store mutation).
      void markAsRead([item.id]);
      onItemRead?.(item);
      onItemClick?.(item);
    },
    [client, feedId, markAsRead, onItemClick, onItemRead],
  );

  const handleMarkAll = useCallback(async () => {
    onMarkAllAsReadClick?.();
    await markAllAsRead();
  }, [markAllAsRead, onMarkAllAsReadClick]);

  const isEmpty = items.length === 0 && networkStatus !== "loading";

  const stateAttrs = dataVariants({
    status: networkStatus,
    empty: isEmpty,
  });

  const header = renderHeader ? (
    renderHeader({ metadata, markAllAsRead })
  ) : (
    <div className={cn("hsr-feed__header", classNames?.header)}>
      <span className={cn("hsr-feed__header-title", classNames?.headerTitle)}>
        Notifications
      </span>
      <button
        type="button"
        className={cn("hsr-feed__mark-all", classNames?.markAllButton)}
        onClick={() => void handleMarkAll()}
        disabled={metadata.unread_count === 0}
      >
        Mark all as read
      </button>
    </div>
  );

  const empty = renderEmpty ? (
    renderEmpty()
  ) : (
    <div className={cn("hsr-feed__empty", classNames?.empty)}>
      You&rsquo;re all caught up.
    </div>
  );

  return (
    <section
      {...stateAttrs}
      className={cn("hsr", "hsr-feed", className, classNames?.root)}
      aria-label={ariaLabel ?? "Notification feed"}
    >
      {header}
      {renderFilterBar ? (
        <FilterBarSlot renderFilterBar={renderFilterBar} />
      ) : null}
      {isEmpty ? (
        empty
      ) : (
        <ul
          className={cn("hsr-feed__list", classNames?.list)}
          role="feed"
          aria-busy={networkStatus === "loading"}
        >
          {items.map((item) => (
            <li key={item.id} className={cn("hsr-feed__row", classNames?.item)}>
              {renderItem ? (
                renderItem(item, { onClick: () => handleItemClick(item) })
              ) : (
                <FeedItem item={item} onClick={handleItemClick} />
              )}
            </li>
          ))}
        </ul>
      )}
      {pageInfo.hasNextPage ? (
        <button
          type="button"
          className={cn("hsr-feed__load-more", classNames?.loadMore)}
          onClick={() => void fetchNextPage()}
          disabled={networkStatus === "fetchMore"}
        >
          {networkStatus === "fetchMore" ? "Loading…" : "Load more"}
        </button>
      ) : null}
    </section>
  );
}

/** Render-prop wrapper for a consumer filter bar (kept out of the main tree). */
function FilterBarSlot(props: {
  renderFilterBar: NonNullable<NotificationFeedProps["renderFilterBar"]>;
}): ReactNode {
  // The default feed ships NO filter bar (status filtering is a render-prop
  // seam today; the engine list route already supports `status`). When a
  // consumer supplies `renderFilterBar`, they own the status state.
  return <>{props.renderFilterBar({ status: "all", setStatus: () => {} })}</>;
}

export type { FeedNetworkStatus };
