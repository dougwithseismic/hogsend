"use client";

/**
 * `<NotificationBell>` — the v1 component SHELL. It is fully styleable now (the
 * five-layer override surface) and binds to `useHogsendFeed().metadata` for its
 * badge, which reads 0 until v2 wires the feed backend. Props mirror Knock.
 *
 * Override surface baked in:
 *   1. `--hs-*` CSS vars (consumer global/scoped retheme)
 *   2. `className` + per-slot `classNames={{ root, badge }}`
 *   3. `data-*` state attrs (`data-unread`, `data-unseen`, `data-has-badge`)
 *   4. `asChild` → in-house Slot merges props onto your element
 *   5. `renderIcon` → full icon markup replacement
 *
 * A11y: `<button aria-label aria-expanded aria-controls>` + an `aria-live`
 * region announcing the unread count; keyboard focus + Enter/Space activation
 * are native to `<button>`.
 */

import { forwardRef, type ReactNode } from "react";
import { useHogsendFeed } from "../../hooks/use-hogsend-feed.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Slot } from "../primitives/slot.js";
import { VisuallyHidden } from "../primitives/visually-hidden.js";

/** Which counter drives the badge. */
export type BadgeCountType = "unread" | "unseen" | "none";

export interface NotificationBellClassNames {
  root?: string;
  badge?: string;
  icon?: string;
}

export interface NotificationBellProps {
  /** Scope the badge to a specific feedId (else provider/default "in_app"). */
  feedId?: string;
  /** Which count to badge. Default "unseen". */
  badgeCountType?: BadgeCountType;
  /** Replace the icon markup entirely (override layer 5). */
  renderIcon?: (state: { count: number }) => ReactNode;
  /** Merge props onto a consumer-provided element (override layer 4). */
  asChild?: boolean;
  onClick?: () => void;
  /** Controlled open state, reflected as `aria-expanded`. */
  isOpen?: boolean;
  /** id of the popover this bell controls, for `aria-controls`. */
  popoverId?: string;
  className?: string;
  classNames?: NotificationBellClassNames;
  "aria-label"?: string;
}

function DefaultBellIcon(): ReactNode {
  return (
    <svg
      className="hsr-bell__icon-svg"
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <path
        d="M10 2.5a4.5 4.5 0 0 0-4.5 4.5v2.6L4 12.5h12l-1.5-2.9V7A4.5 4.5 0 0 0 10 2.5Z"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path d="M8 15a2 2 0 0 0 4 0" strokeLinecap="round" />
    </svg>
  );
}

export const NotificationBell = forwardRef<
  HTMLButtonElement,
  NotificationBellProps
>(function NotificationBell(props, ref) {
  const {
    feedId,
    badgeCountType = "unseen",
    renderIcon,
    asChild = false,
    onClick,
    isOpen,
    popoverId,
    className,
    classNames,
    "aria-label": ariaLabel,
  } = props;

  const { metadata } = useHogsendFeed(feedId ? { feedId } : undefined);
  const count =
    badgeCountType === "unread"
      ? metadata.unread_count
      : badgeCountType === "unseen"
        ? metadata.unseen_count
        : 0;
  const hasBadge = badgeCountType !== "none" && count > 0;

  const stateAttrs = dataVariants({
    unread: badgeCountType === "unread" && count > 0,
    unseen: badgeCountType === "unseen" && count > 0,
    hasBadge,
    state: isOpen ? "open" : "closed",
  });

  const label =
    ariaLabel ??
    (hasBadge ? `Notifications, ${count} unread` : "Notifications");

  const content = (
    <>
      <span className={cn("hsr-bell__icon", classNames?.icon)}>
        {renderIcon ? renderIcon({ count }) : <DefaultBellIcon />}
      </span>
      {hasBadge ? (
        <span
          className={cn("hsr-bell__badge", classNames?.badge)}
          data-hs-badge=""
          aria-hidden="true"
        >
          {count > 99 ? "99+" : count}
        </span>
      ) : null}
      {/* Polite live announcement for SR users. */}
      <VisuallyHidden>
        <span aria-live="polite">{label}</span>
      </VisuallyHidden>
    </>
  );

  const sharedProps = {
    ...stateAttrs,
    className: cn("hsr-bell", className, classNames?.root),
    "aria-label": label,
    "aria-expanded": isOpen,
    "aria-haspopup": "dialog" as const,
    ...(popoverId ? { "aria-controls": popoverId } : {}),
    onClick,
  };

  if (asChild) {
    return (
      <Slot ref={ref} {...sharedProps}>
        {content}
      </Slot>
    );
  }

  return (
    <button ref={ref} type="button" {...sharedProps}>
      {content}
    </button>
  );
});
