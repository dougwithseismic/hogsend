"use client";

/**
 * `<SwipeableFeedRow>` — one notification row with swipe-left-to-archive, layered
 * on top of `@hogsend/react`'s default `<FeedItemView>` (we CONSUME the package,
 * never fork it). The package's `markAsArchived` is a SOFT archive: it
 * optimistically flips `status` to "archived" but keeps the row in the feed
 * `items`, so the parent `<FeedPanel>` filters archived rows out and this row
 * just has to play the exit + call the archive method.
 *
 * Gesture (hand-rolled, dependency-free):
 *   - pointer down records the origin; pointer move locks an axis once it clears
 *     a small slop. Vertical wins → we bail and let the list scroll (`touch-action:
 *     pan-y` on the track means the browser keeps owning vertical pans).
 *   - horizontal-left translates the track, revealing the "Archive" affordance
 *     behind it; past the threshold (min(40% width, 80px)) the affordance arms.
 *   - release past threshold → optimistic archive + animate the row out; under
 *     threshold → snap back.
 *
 * A11y: swipe is pointer-only, so each row also renders a real `<button>` (shown
 * on row hover / keyboard focus, always in the tab order) that calls the SAME
 * archive method. `prefers-reduced-motion` skips the slide/collapse animation.
 */

import { type FeedItem, FeedItemView } from "@hogsend/react";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

/** Exit-animation duration; kept in sync with the CSS transition. */
const EXIT_MS = 220;
/** Movement (px) before we commit to an axis. */
const SLOP = 6;
/** Fallback width when the track hasn't been measured yet. */
const FALLBACK_WIDTH = 320;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

export interface SwipeableFeedRowProps {
  item: FeedItem;
  /** Optimistic soft-archive (the feed's `markAsArchived([id])`). */
  onArchive: (id: string) => void;
  /** Row click → emit `inapp.item_clicked` + mark read (parity w/ the feed). */
  onItemClick: (item: FeedItem) => void;
}

export function SwipeableFeedRow({
  item,
  onArchive,
  onItemClick,
}: SwipeableFeedRowProps) {
  const [dragX, setDragX] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [armed, setArmed] = useState(false);

  const trackRef = useRef<HTMLDivElement | null>(null);
  const startX = useRef(0);
  const startY = useRef(0);
  const axis = useRef<"idle" | "horizontal" | "vertical">("idle");
  // True once a horizontal drag happened, so the trailing click (a swipe ends
  // with a synthetic click) doesn't also fire the row's "mark read".
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
    if (archivedOnce.current) return;
    archivedOnce.current = true;
    setDragging(false);
    setArmed(false);
    setRemoving(true);
    if (prefersReducedMotion()) {
      onArchive(item.id);
    } else {
      exitTimer.current = window.setTimeout(() => onArchive(item.id), EXIT_MS);
    }
  }, [item.id, onArchive]);

  const settle = useCallback(() => {
    axis.current = "idle";
    setDragging(false);
    setDragX(0);
    setArmed(false);
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (removing || !e.isPrimary) return;
      if (e.pointerType === "mouse" && e.button !== 0) return;
      startX.current = e.clientX;
      startY.current = e.clientY;
      axis.current = "idle";
      didDrag.current = false;
      widthRef.current = trackRef.current?.offsetWidth ?? 0;
    },
    [removing],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (removing) return;
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
    [removing, threshold],
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

  const handleRowClick = useCallback(() => {
    if (didDrag.current) {
      didDrag.current = false; // consume the post-swipe synthetic click
      return;
    }
    onItemClick(item);
  }, [item, onItemClick]);

  const label = item.title ?? item.body ?? "notification";

  return (
    <li
      className="hsr-feed__row hs-swipe-row"
      data-removing={removing ? "true" : undefined}
    >
      <div className="hs-swipe-clip">
        <div
          className="hs-swipe-affordance"
          data-armed={armed ? "true" : undefined}
          aria-hidden="true"
        >
          <span className="hs-swipe-affordance__label">Archive</span>
        </div>
        <div
          ref={trackRef}
          className="hs-swipe-track"
          style={{
            transform: removing
              ? "translateX(-110%)"
              : `translateX(${dragX}px)`,
            transition: dragging ? "none" : undefined,
          }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          <FeedItemView item={item} onClick={handleRowClick} />
          <button
            type="button"
            className="hs-swipe-archive"
            // Don't let a tap on the button start a drag or trip the row click.
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              archive();
            }}
            aria-label={`Archive: ${label}`}
            title="Archive"
          >
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
          </button>
        </div>
      </div>
    </li>
  );
}
