"use client";

/**
 * `useToast()` — the v3 ephemeral-toast hook. Toasts are NOT in the persisted
 * `HogsendState` store; the toast client owns a tiny dedicated subscribable, so
 * this hook binds via `useSyncExternalStore` to the client's
 * `subscribe`/`getSnapshot` and delegates `show`/`dismiss`/`click` to the SDK
 * (where `inapp.toast_*` emission lives).
 */

import type { ShowToastInput, Toast, ToastClient } from "@hogsend/js";
import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { HogsendContext } from "../provider/context.js";

/** Return shape of {@link useToast}. */
export interface UseToast {
  /** Current visible toasts (stable array ref between mutations). */
  toasts: Toast[];
  /**
   * Show a toast; returns its (minted-if-omitted) id.
   *
   * `ShowToastInput = Omit<Toast, "id"> & { id?: string }`:
   * `{ type: string; title?; body?; actionUrl?; metadata?; duration?: number }`.
   * `duration` is in ms — omit it for a sticky toast. The SDK emits
   * `inapp.toast_shown` on `show` (and `inapp.toast_{clicked,dismissed}` via
   * `click`/`dismiss`); the component never captures.
   */
  show: (toast: ShowToastInput) => string;
  /** Dismiss a toast (`inapp.toast_dismissed`). */
  dismiss: (id: string) => void;
  /** Record a toast click (`inapp.toast_clicked`). */
  click: (id: string) => void;
}

/** The v3 toast hook. Must be used within `<HogsendProvider>`. */
export function useToast(): UseToast {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useToast must be used within <HogsendProvider>");
  }
  const toast: ToastClient = useMemo(() => ctx.client.toasts(), [ctx.client]);

  const toasts = useSyncExternalStore(
    toast.subscribe,
    toast.getSnapshot,
    toast.getSnapshot,
  );

  const show = useCallback((t: ShowToastInput) => toast.show(t), [toast]);
  const dismiss = useCallback((id: string) => toast.dismiss(id), [toast]);
  const click = useCallback((id: string) => toast.click(id), [toast]);

  return { toasts, show, dismiss, click };
}
