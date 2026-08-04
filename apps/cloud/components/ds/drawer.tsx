"use client";

import { ChevronRight, X } from "lucide-react";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";

/**
 * A settings panel that opens from the right, over the page.
 *
 * Built on the native `<dialog>` element with `showModal()`, which is the whole
 * reason to prefer it over a hand-rolled overlay: the browser gives us the
 * focus trap, the Escape key, the inert background and the top-layer stacking
 * for free. Every one of those is a thing a bespoke drawer gets subtly wrong.
 *
 * The trigger is a ROW, not a button-shaped button: the page reads as a list of
 * things about this environment, and each row opens the detail for one of them.
 * The summary sits on the row so the common case — "what is my URL" — is
 * answered without opening anything.
 *
 * Children are rendered by the server and passed through, so the drawer holds
 * live data without this client component ever fetching any.
 */
export function Drawer({
  title,
  description,
  summary,
  children,
  className,
}: {
  title: string;
  /** One plain sentence under the drawer's heading. Optional. */
  description?: string;
  /** Shown on the closed row — the answer most visits are looking for. */
  summary?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  // Where the press STARTED. A click's target is the common ancestor of its
  // mousedown and mouseup, so selecting text inside the panel and releasing
  // over the backdrop reports the dialog itself — closing the drawer and
  // discarding whatever was half-typed in it.
  const pressedBackdrop = useRef(false);

  // `showModal()` cannot be an attribute, so opening is an effect rather than
  // JSX. Closing goes through the same state, so there is one source of truth.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={cn(
          "group flex w-full items-center justify-between gap-4 rounded-md border border-white/[0.08] bg-white/[0.015] px-6 py-4 text-left",
          "transition-colors hover:border-white/15 hover:bg-white/[0.03]",
          className,
        )}
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-sm text-white tracking-[-0.02em]">
            {title}
          </span>
          {summary ? (
            <span className="truncate text-sm text-white/50">{summary}</span>
          ) : null}
        </span>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-white/30 transition-colors group-hover:text-white/60"
          strokeWidth={2}
        />
      </button>

      {/*
        biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard path exists
        and is the browser's — <dialog> closes on Escape and fires `close`,
        handled below. The click handler only adds click-outside for a pointer;
        a key handler here would duplicate Escape, and the element is never
        focusable so it could not receive one anyway.
      */}
      <dialog
        ref={dialogRef}
        // `close` fires for the Escape key too, so state follows the element
        // rather than the other way round — otherwise Escape would leave the
        // dialog shut and this component believing it is open.
        onClose={() => setOpen(false)}
        // The backdrop is part of the dialog's own box, so a click lands here
        // when it misses the panel. Comparing the target to the dialog itself
        // is what distinguishes backdrop from content.
        onPointerDown={(event) => {
          pressedBackdrop.current = event.target === dialogRef.current;
        }}
        onClick={(event) => {
          if (pressedBackdrop.current && event.target === dialogRef.current) {
            setOpen(false);
          }
          pressedBackdrop.current = false;
        }}
        className={cn(
          "m-0 ml-auto h-dvh max-h-dvh w-full max-w-[min(30rem,100vw)] bg-transparent p-0",
          "backdrop:bg-black/60 open:animate-[drawer-in_180ms_ease-out]",
        )}
      >
        <div className="flex h-full flex-col border-white/[0.08] border-l bg-[#0b0b0e] text-white">
          <div className="flex items-start justify-between gap-4 border-white/[0.08] border-b px-6 py-5">
            <div className="flex flex-col gap-1.5">
              <h2 className="font-medium text-white tracking-[-0.02em]">
                {title}
              </h2>
              {description ? (
                <p className="max-w-prose text-sm text-white/55 leading-6">
                  {description}
                </p>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={`Close ${title}`}
              className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border border-white/[0.08] text-white/60 transition-colors hover:border-white/20 hover:text-white"
            >
              <X aria-hidden className="size-4" strokeWidth={2} />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto px-6 py-5">{children}</div>
        </div>
      </dialog>
    </>
  );
}
