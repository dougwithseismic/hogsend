"use client";

/**
 * `<FeedItem>` — one notification row. The default render for an item in
 * `<NotificationFeed>`. Fully styleable via the five-layer surface (plan §6):
 *   1. `--hs-*` CSS vars
 *   2. `className` + per-slot `classNames={{ root, title, body, timestamp, unreadDot, action }}`
 *   3. `data-*` state (`data-status`, `data-unread`, `data-unseen`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. consumers replace the WHOLE row via `<NotificationFeed renderItem>`
 *
 * Clicking the row (or its action link) routes through `onItemClick`, which the
 * feed component wires to emit `inapp.item_clicked` BEFORE the consumer handler
 * and mark the item read — that emission lives in the feed component, not here.
 *
 * A11y: `role="article"` with a label; the row is keyboard-activatable when an
 * `onClick` is supplied (Enter/Space), and the action renders as a real anchor.
 */

import type { FeedItem as FeedItemData } from "@hogsend/js";
import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Slot } from "../primitives/slot.js";

/** Per-slot class overrides for {@link FeedItem}. */
export interface FeedItemClassNames {
  root?: string;
  unreadDot?: string;
  content?: string;
  title?: string;
  body?: string;
  timestamp?: string;
  action?: string;
}

/** Props for {@link FeedItem}. */
export interface FeedItemProps {
  item: FeedItemData;
  /** Row click (the feed wires this to emit `inapp.item_clicked` first). */
  onClick?: (item: FeedItemData) => void;
  /** Merge props onto a consumer element (override layer 4). */
  asChild?: boolean;
  className?: string;
  classNames?: FeedItemClassNames;
  /** Replace the relative-time formatter. */
  formatTimestamp?: (iso: string) => string;
}

/** Tiny dependency-free relative-time formatter (best-effort). */
function defaultFormatTimestamp(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(then).toLocaleDateString();
}

export const FeedItem = forwardRef<HTMLDivElement, FeedItemProps>(
  function FeedItem(props, ref) {
    const {
      item,
      onClick,
      asChild = false,
      className,
      classNames,
      formatTimestamp = defaultFormatTimestamp,
    } = props;

    const isUnseen = item.status === "unseen";
    const isUnread = item.status === "unseen" || item.status === "seen";

    const stateAttrs = dataVariants({
      status: item.status,
      unread: isUnread,
      unseen: isUnseen,
    });

    const handleClick = (_e: MouseEvent): void => {
      onClick?.(item);
    };
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (!onClick) return;
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        onClick(item);
      }
    };

    const interactive = Boolean(onClick);

    const content = (
      <>
        {isUnread ? (
          <span
            className={cn("hsr-feed-item__unread-dot", classNames?.unreadDot)}
            data-hs-unread-dot=""
            aria-hidden="true"
          />
        ) : null}
        <div className={cn("hsr-feed-item__content", classNames?.content)}>
          {item.title ? (
            <div className={cn("hsr-feed-item__title", classNames?.title)}>
              {item.title}
            </div>
          ) : null}
          {item.body ? (
            <div className={cn("hsr-feed-item__body", classNames?.body)}>
              {item.body}
            </div>
          ) : null}
          <div
            className={cn("hsr-feed-item__timestamp", classNames?.timestamp)}
          >
            {formatTimestamp(item.createdAt)}
          </div>
        </div>
        {item.actionUrl ? (
          <a
            className={cn("hsr-feed-item__action", classNames?.action)}
            href={item.actionUrl}
            // Let the row's click handler emit + mark; don't double-fire.
            onClick={(e) => e.stopPropagation()}
          >
            Open
          </a>
        ) : null}
      </>
    );

    const sharedProps = {
      ...stateAttrs,
      className: cn("hsr-feed-item", className, classNames?.root),
      role: "article",
      "aria-label": item.title ?? item.body ?? "Notification",
      ...(interactive
        ? {
            tabIndex: 0,
            onClick: handleClick,
            onKeyDown: handleKeyDown,
          }
        : {}),
    } as const;

    if (asChild) {
      return (
        <Slot ref={ref} {...sharedProps}>
          {content as ReactNode}
        </Slot>
      );
    }

    return (
      <div ref={ref} {...sharedProps}>
        {content}
      </div>
    );
  },
);
