"use client";

/**
 * `<FeedPanel>` — a drop-in for `@hogsend/react`'s `<FeedPopover>` for the docs
 * nav bell, written so each row can be swipe-to-archive.
 *
 * Why not just `<FeedPopover renderItem={...}>`? The package archive is a SOFT
 * archive: `markAsArchived` optimistically flips `status` to "archived" but KEEPS
 * the row in the feed `items` (it's a patch, not a removal), and the package
 * `<NotificationFeed>` decides "empty" by `items.length === 0`. So the `renderItem`
 * seam alone can neither drop an archived row nor restore the empty state once an
 * item is archived. We therefore render the list ourselves (the task's stated
 * fallback) and filter `status !== "archived"`, while REUSING the package's
 * `.hsr-popover` / `.hsr-feed*` class names so the crimzon skin (bell-theme.css)
 * and the existing fixed-anchor positioning in `nav-bell.tsx` stay identical.
 *
 * Behaviour kept at parity with `<FeedPopover>` / `<NotificationFeed>`:
 *   - `inapp.feed_opened` on the closed→open transition
 *   - Esc-to-close (restores focus to the trigger) + outside-pointer dismiss
 *   - row click → `inapp.item_clicked` (before) → mark read
 *   - header "Mark all as read"
 *   - `renderEmpty` passthrough
 */

import { type FeedItem, useHogsend, useHogsendFeed } from "@hogsend/react";
import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useRef,
} from "react";
import { SwipeableFeedRow } from "./swipeable-feed-row";

type Placement = "bottom-start" | "bottom-end" | "top-start" | "top-end";

export interface FeedPanelProps {
  /** id used for `aria-controls` wiring from the bell. */
  id?: string;
  isVisible: boolean;
  /** Called to request close (Esc / outside click). */
  onClose: () => void;
  /** Trigger ref — focus returns here on Esc; clicks on it don't dismiss. */
  buttonRef?: RefObject<HTMLElement | null>;
  placement?: Placement;
  feedId?: string;
  /** Replace the empty state (matches `FeedPopover`'s passthrough). */
  renderEmpty?: () => ReactNode;
}

export function FeedPanel({
  id,
  isVisible,
  onClose,
  buttonRef,
  placement = "bottom-end",
  feedId,
  renderEmpty,
}: FeedPanelProps) {
  const { client } = useHogsend();
  const feed = useHogsendFeed(feedId ? { feedId } : undefined);
  const {
    items,
    metadata,
    networkStatus,
    markAsArchived,
    markAsRead,
    markAllAsRead,
  } = feed;

  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasVisible = useRef(false);

  // `inapp.feed_opened` once on closed→open (parity with FeedPopover).
  useEffect(() => {
    if (isVisible && !wasVisible.current) {
      void client.capture("inapp.feed_opened", { feedId: feedId ?? "in_app" });
    }
    wasVisible.current = isVisible;
  }, [isVisible, client, feedId]);

  // Esc-to-close (+ restore focus) and outside-pointer dismiss.
  useEffect(() => {
    if (!isVisible) return;
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        buttonRef?.current?.focus();
      }
    };
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node | null;
      if (panelRef.current?.contains(target)) return;
      if (buttonRef?.current?.contains(target)) return; // bell toggles itself
      onClose();
    };
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [isVisible, onClose, buttonRef]);

  // Row click → emit `inapp.item_clicked` BEFORE marking read (parity).
  const handleItemClick = useCallback(
    (item: FeedItem) => {
      void client.capture("inapp.item_clicked", {
        feedItemId: item.id,
        feedId: feedId ?? item.category,
        ...(item.actionUrl ? { actionUrl: item.actionUrl } : {}),
      });
      void markAsRead([item.id]);
    },
    [client, feedId, markAsRead],
  );

  const handleArchive = useCallback(
    (itemId: string) => {
      void markAsArchived([itemId]);
    },
    [markAsArchived],
  );

  if (!isVisible) return null;

  // Soft-archive: `markAsArchived` flips status but keeps the row in `items`, so
  // hide archived here (this is the filtering the renderItem seam can't do).
  const visible = items.filter((it) => it.status !== "archived");
  const isEmpty = visible.length === 0 && networkStatus !== "loading";

  return (
    <div
      ref={panelRef}
      {...(id ? { id } : {})}
      data-placement={placement}
      data-state="open"
      className="hsr hsr-popover"
      role="dialog"
      aria-modal="false"
      aria-label="Notifications"
    >
      <section className="hsr hsr-feed" aria-label="Notification feed">
        <div className="hsr-feed__header">
          <span className="hsr-feed__header-title">Notifications</span>
          <button
            type="button"
            className="hsr-feed__mark-all"
            onClick={() => void markAllAsRead()}
            disabled={metadata.unread_count === 0}
          >
            Mark all as read
          </button>
        </div>
        {isEmpty ? (
          renderEmpty ? (
            renderEmpty()
          ) : (
            <div className="hsr-feed__empty">You&rsquo;re all caught up.</div>
          )
        ) : (
          <ul
            className="hsr-feed__list"
            role="feed"
            aria-busy={networkStatus === "loading"}
          >
            {visible.map((item) => (
              <SwipeableFeedRow
                key={item.id}
                item={item}
                onArchive={handleArchive}
                onItemClick={handleItemClick}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
