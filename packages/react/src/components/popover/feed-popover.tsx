"use client";

/**
 * `<FeedPopover>` — the overlay that hosts a `<NotificationFeed>` anchored to a
 * trigger (typically `<NotificationBell>`). Handles open/close, `Esc`-to-close
 * (returns focus to the trigger), an outside-click dismiss, and placement via a
 * `data-placement` attribute the CSS positions against. Emits `inapp.feed_opened`
 * through `client.capture(...)` on the closed→open transition (plan §5).
 *
 * Controlled: the consumer owns `isVisible` + `onClose` (mirrors Knock's
 * `<NotificationFeedPopover>`), so the bell and popover stay decoupled.
 *
 * Override surface (plan §6): `className` + per-slot `classNames`, `data-*`
 * state (`data-placement`, `data-state`), and it forwards `renderItem`/
 * `renderHeader`/`renderEmpty`/`onItemClick` straight to `<NotificationFeed>`.
 *
 * Lazy-friendly: no top-level side effects → `React.lazy(() => import(...))`.
 *
 * A11y: `role="dialog"` + `aria-modal="false"` (non-blocking), `aria-label`,
 * `Esc` closes + restores focus to `buttonRef`. Full focus-trap is intentionally
 * NOT imposed (a notification popover is non-modal); the `VisuallyHidden` +
 * focus helpers are exported for consumers who want a modal variant.
 */

import { type ReactNode, type RefObject, useEffect, useRef } from "react";
import { useHogsend } from "../../hooks/use-hogsend.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import {
  NotificationFeed,
  type NotificationFeedProps,
} from "../feed/notification-feed.js";

/** Where the popover sits relative to its trigger. */
export type FeedPopoverPlacement =
  | "bottom-start"
  | "bottom-end"
  | "top-start"
  | "top-end";

/** Per-slot class overrides for {@link FeedPopover}. */
export interface FeedPopoverClassNames {
  root?: string;
}

/** Props for {@link FeedPopover}. */
export interface FeedPopoverProps {
  /** Controlled visibility. */
  isVisible: boolean;
  /** Called to request close (Esc / outside click / consumer). */
  onClose: () => void;
  /** The trigger ref — focus returns here on close. */
  buttonRef?: RefObject<HTMLElement | null>;
  /** Placement against the trigger. Default "bottom-end". */
  placement?: FeedPopoverPlacement;
  /** Feed scope passthrough. */
  feedId?: NotificationFeedProps["feedId"];
  /** Forwarded to the inner `<NotificationFeed>`. */
  renderItem?: NotificationFeedProps["renderItem"];
  renderHeader?: NotificationFeedProps["renderHeader"];
  renderEmpty?: NotificationFeedProps["renderEmpty"];
  onItemClick?: NotificationFeedProps["onItemClick"];
  onMarkAllAsReadClick?: NotificationFeedProps["onMarkAllAsReadClick"];
  className?: string;
  classNames?: FeedPopoverClassNames;
  /** id used for `aria-controls` wiring from the bell. */
  id?: string;
  "aria-label"?: string;
}

export function FeedPopover(props: FeedPopoverProps): ReactNode {
  const {
    isVisible,
    onClose,
    buttonRef,
    placement = "bottom-end",
    feedId,
    renderItem,
    renderHeader,
    renderEmpty,
    onItemClick,
    onMarkAllAsReadClick,
    className,
    classNames,
    id,
    "aria-label": ariaLabel,
  } = props;

  const { client } = useHogsend();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const wasVisible = useRef(false);

  // Emit `inapp.feed_opened` once on the closed→open transition.
  useEffect(() => {
    if (isVisible && !wasVisible.current) {
      void client.capture("inapp.feed_opened", {
        feedId: feedId ?? "in_app",
      });
    }
    wasVisible.current = isVisible;
  }, [isVisible, client, feedId]);

  // Esc to close + outside-click dismiss; restore focus to the trigger.
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

  if (!isVisible) return null;

  const stateAttrs = dataVariants({
    placement,
    state: "open",
  });

  return (
    <div
      ref={panelRef}
      {...stateAttrs}
      {...(id ? { id } : {})}
      className={cn("hsr", "hsr-popover", className, classNames?.root)}
      role="dialog"
      aria-modal="false"
      aria-label={ariaLabel ?? "Notifications"}
    >
      <NotificationFeed
        {...(feedId ? { feedId } : {})}
        {...(renderItem ? { renderItem } : {})}
        {...(renderHeader ? { renderHeader } : {})}
        {...(renderEmpty ? { renderEmpty } : {})}
        {...(onItemClick ? { onItemClick } : {})}
        {...(onMarkAllAsReadClick ? { onMarkAllAsReadClick } : {})}
      />
    </div>
  );
}
