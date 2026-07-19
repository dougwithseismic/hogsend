"use client";

import { motion, useDragControls } from "motion/react";
import { type ReactNode, useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/* ==========================================================================
 *  SPIKE — a draggable, resizable glass window.
 *
 *  Drag comes from motion (already a dependency) so the window keeps its slot
 *  in the layout and only moves by transform — nothing reflows around it.
 *  Resize is a corner handle driven by raw pointer events, tracked in state so
 *  the size survives a drag.
 *
 *  `handle` is the row the window drags by (the tab rail), rendered by the
 *  caller so each window can put whatever chrome it wants up there.
 * ========================================================================== */

/** `width` is optional: omit it and the window fills its slot (the docked one)
 *  until the first resize, which measures the rendered width and takes over. */
export type WindowSize = { width?: number; height: number };

export function WindowFrame({
  handle,
  children,
  size,
  minSize = { width: 320, height: 200 } as Required<WindowSize>,
  className,
  dragConstraints,
  initialPosition,
  elevated,
  onFocus,
}: {
  handle: ReactNode;
  children: ReactNode;
  size: WindowSize;
  minSize?: Required<WindowSize>;
  className?: string;
  dragConstraints?: React.RefObject<HTMLElement | null>;
  initialPosition?: { x: number; y: number };
  /** Raise above sibling windows (the caller tracks stacking order). */
  elevated?: boolean;
  onFocus?: () => void;
}) {
  const [box, setBox] = useState<WindowSize>(size);
  const dragControls = useDragControls();
  const frameRef = useRef<HTMLDivElement>(null);

  // Corner resize. Pointer capture keeps events coming even when the cursor
  // outruns the handle, and we clamp against minSize on every move.
  const startResize = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const handleEl = event.currentTarget;
      handleEl.setPointerCapture(event.pointerId);

      const originX = event.clientX;
      const originY = event.clientY;
      // a fluid window has no tracked width yet — measure what it rendered at
      const startWidth = box.width ?? frameRef.current?.offsetWidth ?? 0;
      const startHeight = box.height;

      const top = frameRef.current?.getBoundingClientRect().top ?? 0;
      const left = frameRef.current?.getBoundingClientRect().left ?? 0;
      // clamp to what is still on screen, so you can always reach the bottom
      // edge (and the grip) after growing the window
      const maxHeight = Math.max(minSize.height, window.innerHeight - top - 16);
      const maxWidth = Math.max(minSize.width, window.innerWidth - left - 16);

      const onMove = (moveEvent: PointerEvent) => {
        setBox({
          width: Math.min(
            maxWidth,
            Math.max(minSize.width, startWidth + (moveEvent.clientX - originX)),
          ),
          height: Math.min(
            maxHeight,
            Math.max(
              minSize.height,
              startHeight + (moveEvent.clientY - originY),
            ),
          ),
        });
      };

      const onUp = () => {
        handleEl.removeEventListener("pointermove", onMove);
        handleEl.removeEventListener("pointerup", onUp);
      };

      handleEl.addEventListener("pointermove", onMove);
      handleEl.addEventListener("pointerup", onUp);
    },
    [box.width, box.height, minSize.width, minSize.height],
  );

  return (
    <motion.div
      ref={frameRef}
      drag
      dragMomentum={false}
      dragElastic={0}
      dragConstraints={dragConstraints}
      dragControls={dragControls}
      dragListener={false}
      onPointerDown={onFocus}
      initial={initialPosition ? { opacity: 0, scale: 0.94 } : false}
      animate={{ opacity: 1, scale: 1 }}
      // closing is a dismissal, not a spring — it drops away rather than
      // bouncing out, so a run clearing three windows does not look chaotic
      exit={{ opacity: 0, scale: 0.96, y: 8, transition: { duration: 0.16 } }}
      transition={{ type: "spring", stiffness: 460, damping: 34, mass: 0.7 }}
      style={{
        ...(box.width ? { width: box.width } : null),
        height: box.height,
        ...(initialPosition
          ? {
              position: "fixed",
              left: initialPosition.x,
              top: initialPosition.y,
            }
          : null),
      }}
      className={cn(
        // select-none on the whole frame: a drag that crosses the code pane
        // would otherwise paint a text selection across the page. Copying is
        // covered by the explicit Copy button in the rail.
        "flex select-none flex-col overflow-hidden rounded-xl border bg-[rgba(18,14,15,0.97)] backdrop-blur-[26px]",
        // a floating window reads as lifted off the page: brighter hairline,
        // a much deeper shadow, and a faint rim light along the top edge
        initialPosition
          ? "border-white/20 shadow-[0_2px_0_rgba(255,255,255,0.06)_inset,0_40px_90px_-20px_rgba(0,0,0,0.9)]"
          : "border-white/[0.14] shadow-[0_24px_70px_-28px_rgba(0,0,0,0.85)]",
        elevated ? "z-50" : "z-40",
        className,
      )}
    >
      <div
        className="shrink-0 cursor-grab select-none active:cursor-grabbing"
        onPointerDown={(event) => {
          // let buttons in the rail win the pointer
          if ((event.target as HTMLElement).closest("button,a")) return;
          // without this the pointer-down seeds a text selection that then
          // drags across the whole page instead of moving the window
          event.preventDefault();
          dragControls.start(event);
        }}
      >
        {handle}
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden">{children}</div>

      {/* resize grip */}
      <button
        type="button"
        aria-label="Resize window"
        onPointerDown={startResize}
        className="absolute right-0 bottom-0 size-4 cursor-nwse-resize"
      >
        <span
          aria-hidden="true"
          className="absolute right-[3px] bottom-[3px] size-2 border-white/25 border-r-2 border-b-2"
        />
      </button>
    </motion.div>
  );
}
