"use client";

/**
 * `<ToastContainer placement>` — renders the live stack of ephemeral toasts via
 * {@link useToast}. Positioned via `--hs-toast-*` + `--hs-z-index`; the
 * `placement` drives `data-placement` and the default skin corner. Each toast's
 * click/dismiss routes through the SDK toast client (where `inapp.toast_*`
 * emission lives).
 */

import type { Toast as ToastData } from "@hogsend/js";
import type { ReactNode } from "react";
import { useToast } from "../../hooks/use-toast.js";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Toast, type ToastClassNames } from "./toast.js";

/** Container corner. */
export type ToastPlacement =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

/** Props for {@link ToastContainer}. */
export interface ToastContainerProps {
  /** Corner placement. Default "top-right". */
  placement?: ToastPlacement;
  /**
   * Replace a single toast's markup (override layer 5), forwarded per-toast to
   * each `<Toast>`. A custom render OWNS its dismiss/click affordances — the
   * `onToastClick`/`onToastDismiss` wiring below only runs for the default
   * skin, so call back through `useToast().dismiss/click` from inside your
   * element to keep the `inapp.toast_*` closed loop intact.
   */
  renderToast?: (toast: ToastData) => ReactNode;
  /** Fired AFTER `inapp.toast_clicked`. */
  onToastClick?: (toast: ToastData) => void;
  /** Fired AFTER `inapp.toast_dismissed`. */
  onToastDismiss?: (toast: ToastData) => void;
  className?: string;
  /** Per-slot class overrides forwarded to each `<Toast>`. */
  toastClassNames?: ToastClassNames;
  "aria-label"?: string;
}

export function ToastContainer(props: ToastContainerProps): ReactNode {
  const {
    placement = "top-right",
    renderToast,
    onToastClick,
    onToastDismiss,
    className,
    toastClassNames,
    "aria-label": ariaLabel,
  } = props;

  const { toasts, dismiss, click } = useToast();

  if (toasts.length === 0) return null;

  const handleClick = (t: ToastData): void => {
    click(t.id);
    onToastClick?.(t);
  };
  const handleDismiss = (t: ToastData): void => {
    dismiss(t.id);
    onToastDismiss?.(t);
  };

  const stateAttrs = dataVariants({ placement });

  return (
    <section
      {...stateAttrs}
      className={cn("hsr", "hsr-toast-container", className)}
      aria-label={ariaLabel ?? "Notifications"}
    >
      {toasts.map((t) => (
        <Toast
          key={t.id}
          toast={t}
          onClick={handleClick}
          onDismiss={handleDismiss}
          {...(renderToast ? { renderToast } : {})}
          {...(toastClassNames ? { classNames: toastClassNames } : {})}
        />
      ))}
    </section>
  );
}
