"use client";

/**
 * `<FeedItem>` — one notification row. The default render for an item in
 * `<NotificationFeed>`. Fully styleable via the five-layer surface (plan §6):
 *   1. `--hs-*` CSS vars
 *   2. `className` + per-slot `classNames={{ root, title, body, timestamp,
 *      unreadDot, action, swipeAffordance, archiveButton }}`
 *   3. `data-*` state (`data-status`, `data-unread`, `data-unseen`, and — when
 *      swipe-to-archive is enabled — `data-swiping`, `data-armed`,
 *      `data-archiving`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. consumers replace the WHOLE row via `<NotificationFeed renderItem>` and
 *      the archive button via `renderArchiveButton`
 *
 * Clicking the row (or its action link) routes through `onItemClick`, which the
 * feed component wires to emit `inapp.item_clicked` BEFORE the consumer handler
 * and mark the item read — that emission lives in the feed component, not here.
 *
 * Swipe-to-archive: when `onArchive` is supplied the row gains a hand-rolled,
 * dependency-free swipe-left gesture (pointer) AND a keyboard/mouse-reachable
 * archive `<button>`. Both call the SAME soft-archive path; the closed-loop
 * `inapp.item_archived` emission lives in the SDK `markAsArchived` store
 * mutation (the feed wires `onArchive → markAsArchived`), NOT here. The gesture
 * locks an axis after a small slop so vertical pans still scroll the list
 * (`touch-action: pan-y`), and `prefers-reduced-motion` skips the exit slide.
 *
 * A11y: `role="article"` with a label; the row is keyboard-activatable when an
 * `onClick` is supplied (Enter/Space), the action renders as a real anchor, and
 * the archive affordance is a real `<button>` in the tab order.
 */

import type { FeedItem as FeedItemData } from "@hogsend/js";
import {
  forwardRef,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Slot } from "../primitives/slot.js";
import { type SurveyBlock, SurveyBlockView } from "./survey-block.js";

/** Exit-animation duration (ms). MUST equal the `--hs-swipe-exit-ms` token. */
const EXIT_MS = 220;
/** Movement (px) before we commit to an axis. */
const SLOP = 6;
/** Fallback track width before the row has been measured. */
const FALLBACK_WIDTH = 320;

/** SSR-guarded reduced-motion check. */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

/** Per-slot class overrides for {@link FeedItem}. */
export interface FeedItemClassNames {
  root?: string;
  unreadDot?: string;
  content?: string;
  title?: string;
  body?: string;
  timestamp?: string;
  action?: string;
  /** The swipe affordance revealed behind the row on a left-swipe. */
  swipeAffordance?: string;
  /** The keyboard/mouse archive button. */
  archiveButton?: string;
}

/** Props for {@link FeedItem}. */
export interface FeedItemProps {
  item: FeedItemData;
  /** Row click (the feed wires this to emit `inapp.item_clicked` first). */
  onClick?: (item: FeedItemData) => void;
  /**
   * Soft-archive this row. When set, the swipe gesture + archive button are
   * enabled (the feed wires this to `markAsArchived([id])`, whose
   * `inapp.item_archived` closed-loop emission lives in the SDK store).
   */
  onArchive?: (item: FeedItemData) => void;
  /** Enable the swipe-left gesture. Default: `Boolean(onArchive)`. */
  swipeToArchive?: boolean;
  /** Show the keyboard/mouse archive button. Default: `Boolean(onArchive)`. */
  showArchiveButton?: boolean;
  /** Replace the archive button markup (override layer 5). */
  renderArchiveButton?: (h: {
    archive: () => void;
    label: string;
  }) => ReactNode;
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

/** Default archive glyph (a small box icon). */
function ArchiveIcon(): ReactNode {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2.5 3.5h11v3h-11z" />
      <path d="M3.5 6.5v6h9v-6M6.3 9.3h3.4" />
    </svg>
  );
}

export const FeedItem = forwardRef<HTMLDivElement, FeedItemProps>(
  function FeedItem(props, ref) {
    const {
      item,
      onClick,
      onArchive,
      asChild = false,
      className,
      classNames,
      renderArchiveButton,
      formatTimestamp = defaultFormatTimestamp,
    } = props;

    const archiveEnabled = Boolean(onArchive);
    const swipeOn = archiveEnabled && (props.swipeToArchive ?? true);
    const buttonOn = archiveEnabled && (props.showArchiveButton ?? true);
    const useSwipeStructure = swipeOn || buttonOn;

    const isUnseen = item.status === "unseen";
    const isUnread = item.status === "unseen" || item.status === "seen";

    // ── swipe gesture state machine (hand-rolled, dependency-free) ──
    const [dragX, setDragX] = useState(0);
    const [dragging, setDragging] = useState(false);
    const [armed, setArmed] = useState(false);
    const [archiving, setArchiving] = useState(false);

    const trackRef = useRef<HTMLDivElement | null>(null);
    const startX = useRef(0);
    const startY = useRef(0);
    const axis = useRef<"idle" | "horizontal" | "vertical">("idle");
    // True once a horizontal drag happened, so the trailing synthetic click
    // (a swipe ends with one) doesn't also fire the row's "mark read".
    const didDrag = useRef(false);
    const archivedOnce = useRef(false);
    const widthRef = useRef(0);
    const exitTimer = useRef<number | null>(null);

    useEffect(
      () => () => {
        if (exitTimer.current != null) window.clearTimeout(exitTimer.current);
      },
      [],
    );

    const threshold = useCallback(
      () => Math.min((widthRef.current || FALLBACK_WIDTH) * 0.4, 80),
      [],
    );

    const archive = useCallback(() => {
      if (!onArchive || archivedOnce.current) return;
      archivedOnce.current = true;
      setDragging(false);
      setArmed(false);
      setArchiving(true);
      if (prefersReducedMotion()) {
        onArchive(item);
      } else {
        exitTimer.current = window.setTimeout(() => onArchive(item), EXIT_MS);
      }
    }, [item, onArchive]);

    const settle = useCallback(() => {
      axis.current = "idle";
      setDragging(false);
      setDragX(0);
      setArmed(false);
    }, []);

    const onPointerDown = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        if (archiving || !e.isPrimary) return;
        if (e.pointerType === "mouse" && e.button !== 0) return;
        startX.current = e.clientX;
        startY.current = e.clientY;
        axis.current = "idle";
        didDrag.current = false;
        widthRef.current = trackRef.current?.offsetWidth ?? 0;
      },
      [archiving],
    );

    const onPointerMove = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        if (archiving) return;
        const dx = e.clientX - startX.current;
        const dy = e.clientY - startY.current;

        if (axis.current === "idle") {
          if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
          if (Math.abs(dy) >= Math.abs(dx)) {
            axis.current = "vertical"; // let the list scroll; abandon the swipe
            return;
          }
          axis.current = "horizontal";
          didDrag.current = true;
          setDragging(true);
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            // best-effort: some browsers reject capture for synthetic ids
          }
        }

        if (axis.current !== "horizontal") return;
        const next = Math.min(0, dx); // archive on left-swipe only
        setDragX(next);
        setArmed(Math.abs(next) >= threshold());
      },
      [archiving, threshold],
    );

    const endDrag = useCallback(
      (e: ReactPointerEvent<HTMLDivElement>) => {
        if (axis.current === "horizontal") {
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            // best-effort
          }
          if (Math.abs(dragX) >= threshold()) {
            archive();
            return;
          }
        }
        settle();
      },
      [dragX, threshold, archive, settle],
    );

    const stateAttrs = dataVariants({
      status: item.status,
      unread: isUnread,
      unseen: isUnseen,
      swiping: dragging,
      armed,
      archiving,
    });

    const handleClick = (_e: MouseEvent): void => {
      // Consume the post-swipe synthetic click so a swipe never marks read.
      if (didDrag.current) {
        didDrag.current = false;
        return;
      }
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
    const label = item.title ?? item.body ?? "notification";

    // The first `survey` block (if any) renders inline as an answerable widget.
    // `item.blocks` is opaque on the wire (`Record<string, unknown>[]`); narrow
    // by `type` and cast to the local `SurveyBlock` shape.
    // TODO: when a second interactive block kind lands, replace this single
    // hand-picked find with a generic switch(block.type) block dispatcher.
    const surveyBlock = item.blocks?.find(
      (b) => (b as { type?: unknown }).type === "survey",
    ) as SurveyBlock | undefined;

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
          {surveyBlock ? (
            <SurveyBlockView item={item} block={surveyBlock} />
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

    const archiveButton = buttonOn ? (
      renderArchiveButton ? (
        renderArchiveButton({ archive, label })
      ) : (
        <button
          type="button"
          className={cn("hsr-feed-item__archive", classNames?.archiveButton)}
          // Don't let a tap on the button start a drag or trip the row click.
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => {
            e.stopPropagation();
            archive();
          }}
          aria-label={`Archive: ${label}`}
          title="Archive"
        >
          <ArchiveIcon />
        </button>
      )
    ) : null;

    const inner = useSwipeStructure ? (
      <div className="hsr-feed-item__clip">
        {swipeOn ? (
          <div
            className={cn(
              "hsr-feed-item__affordance",
              classNames?.swipeAffordance,
            )}
            data-armed={armed ? "" : undefined}
            aria-hidden="true"
          >
            <span className="hsr-feed-item__affordance-label">Archive</span>
          </div>
        ) : null}
        <div
          ref={trackRef}
          className="hsr-feed-item__track"
          style={{
            transform: archiving
              ? "translateX(-110%)"
              : `translateX(${dragX}px)`,
            ...(dragging ? { transition: "none" } : {}),
          }}
          {...(swipeOn
            ? {
                onPointerDown,
                onPointerMove,
                onPointerUp: endDrag,
                onPointerCancel: endDrag,
              }
            : {})}
        >
          {content}
          {archiveButton}
        </div>
      </div>
    ) : (
      content
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
          {inner as ReactNode}
        </Slot>
      );
    }

    return (
      <div ref={ref} {...sharedProps}>
        {inner}
      </div>
    );
  },
);
