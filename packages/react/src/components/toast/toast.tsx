"use client";

/**
 * `<Toast>` — one ephemeral toast row. The default render for a toast in
 * `<ToastContainer>`. Styleable via the five-layer surface (plan §6):
 *   1. `--hs-toast-*` CSS vars
 *   2. `className` + per-slot `classNames={{ root, content, title, body, action, dismiss }}`
 *   3. `data-*` state (`data-type`)
 *   4. `asChild` → Slot merges our props onto the consumer's element
 *   5. `renderToast` replaces the WHOLE toast
 *
 * Click/dismiss emission (`inapp.toast_*`) lives in the SDK; auto-dismiss is the
 * toast store's job (the component just renders + offers a close button).
 */

import type { Toast as ToastData } from "@hogsend/js";
import { forwardRef, type ReactNode } from "react";
import { cn } from "../../lib/cn.js";
import { dataVariants } from "../../lib/variants.js";
import { Slot } from "../primitives/slot.js";

/** Per-slot class overrides for {@link Toast}. */
export interface ToastClassNames {
  root?: string;
  content?: string;
  title?: string;
  body?: string;
  action?: string;
  dismiss?: string;
}

/** Props for {@link Toast}. */
export interface ToastProps {
  toast: ToastData;
  /** Click handler (the container wires `inapp.toast_clicked`). */
  onClick?: (toast: ToastData) => void;
  /** Dismiss handler (the container wires `inapp.toast_dismissed`). */
  onDismiss?: (toast: ToastData) => void;
  /** Replace the whole toast markup (override layer 5). */
  renderToast?: (toast: ToastData) => ReactNode;
  /** Merge props onto a consumer element (override layer 4). */
  asChild?: boolean;
  className?: string;
  classNames?: ToastClassNames;
}

export const Toast = forwardRef<HTMLDivElement, ToastProps>(
  function Toast(props, ref) {
    const {
      toast,
      onClick,
      onDismiss,
      renderToast,
      asChild = false,
      className,
      classNames,
    } = props;

    if (renderToast) return <>{renderToast(toast)}</>;

    const stateAttrs = dataVariants({ type: toast.type });

    const content = (
      <>
        <div className={cn("hsr-toast__content", classNames?.content)}>
          {toast.title ? (
            <div className={cn("hsr-toast__title", classNames?.title)}>
              {toast.title}
            </div>
          ) : null}
          {toast.body ? (
            <div className={cn("hsr-toast__body", classNames?.body)}>
              {toast.body}
            </div>
          ) : null}
        </div>
        {toast.actionUrl ? (
          <a
            className={cn("hsr-toast__action", classNames?.action)}
            href={toast.actionUrl}
            onClick={(e) => {
              e.stopPropagation();
              onClick?.(toast);
            }}
          >
            Open
          </a>
        ) : null}
        <button
          type="button"
          className={cn("hsr-toast__dismiss", classNames?.dismiss)}
          onClick={(e) => {
            e.stopPropagation();
            onDismiss?.(toast);
          }}
          aria-label="Dismiss"
        >
          ×
        </button>
      </>
    );

    const sharedProps = {
      ...stateAttrs,
      className: cn("hsr-toast", className, classNames?.root),
      role: "status",
      "aria-label": toast.title ?? toast.body ?? "Notification",
      ...(onClick ? { onClick: () => onClick(toast) } : {}),
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
