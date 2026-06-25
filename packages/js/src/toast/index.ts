/**
 * Toast client — v3. Ephemeral, client-side toasts: NOT persisted, NOT in the
 * reactive `HogsendState` store (a toast auto-dismiss must not churn feed/banner
 * selectors). Its own tiny subscribable store + per-toast auto-dismiss timers.
 *
 * Sources: (a) explicit `show()` (consumer-driven), and (b) realtime feed items
 * of `type === "toast"` — `client.connect()` routes those into `show()` (an
 * additive branch that does not touch the feed-store upsert path). Events
 * (`inapp.toast_shown` / `_clicked` / `_dismissed`) flow through `spine.capture`
 * only; toasts make no transport/mark calls of their own.
 */

import type { EventSpine } from "../spine/event-spine.js";

/** A single ephemeral toast. */
export interface Toast {
  id: string;
  type: string;
  title: string | null;
  body: string | null;
  actionUrl: string | null;
  metadata: Record<string, unknown> | null;
  /** Auto-dismiss after N ms; undefined = sticky. */
  duration?: number;
}

/** Input to `show()` — `id` minted if omitted. */
export type ShowToastInput = Omit<Toast, "id"> & { id?: string };

/** The toast sub-client. */
export interface ToastClient {
  /** Current visible toasts (stable array ref between mutations). */
  list(): Toast[];
  /** Show a toast; returns its id. */
  show(toast: ShowToastInput): string;
  /** Dismiss a toast (`inapp.toast_dismissed`). */
  dismiss(id: string): void;
  /** Record a toast click (`inapp.toast_clicked`). */
  click(id: string): void;
  /** Subscribe to toast changes (for `useSyncExternalStore`). */
  subscribe(listener: () => void): () => void;
  /** Snapshot for `useSyncExternalStore`. */
  getSnapshot(): Toast[];
  /** Clear timers + listeners. */
  teardown(): void;
}

export interface ToastClientOptions {
  spine: EventSpine;
}

let toastSeq = 0;
function mintToastId(): string {
  toastSeq += 1;
  return `toast_${Date.now().toString(36)}_${toastSeq.toString(36)}`;
}

/**
 * Build the toast client. Holds a transient ordered list + per-toast
 * `setTimeout` for auto-dismiss; the snapshot array is rebuilt on every change
 * (stable ref between mutations) so `useSyncExternalStore` stays correct.
 */
export function createToastClient(opts: ToastClientOptions): ToastClient {
  const { spine } = opts;
  const byId = new Map<string, Toast>();
  const order: string[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>();

  // Cached snapshot — only rebuilt on change (useSyncExternalStore needs a
  // stable reference when nothing changed).
  let snapshot: Toast[] = [];

  function rebuild(): void {
    snapshot = order.map((id) => byId.get(id)).filter((t): t is Toast => !!t);
  }

  function emit(): void {
    rebuild();
    for (const l of listeners) l();
  }

  function clearTimer(id: string): void {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  function remove(id: string): void {
    if (!byId.has(id)) return;
    byId.delete(id);
    const idx = order.indexOf(id);
    if (idx >= 0) order.splice(idx, 1);
    clearTimer(id);
    emit();
  }

  function show(input: ShowToastInput): string {
    const id = input.id ?? mintToastId();
    const toast: Toast = {
      id,
      type: input.type,
      title: input.title ?? null,
      body: input.body ?? null,
      actionUrl: input.actionUrl ?? null,
      metadata: input.metadata ?? null,
      ...(input.duration !== undefined ? { duration: input.duration } : {}),
    };
    if (!byId.has(id)) order.push(id);
    byId.set(id, toast);
    clearTimer(id);
    if (toast.duration !== undefined && toast.duration > 0) {
      timers.set(
        id,
        setTimeout(() => remove(id), toast.duration),
      );
    }
    emit();
    void spine.capture("inapp.toast_shown", { toastId: id, type: toast.type });
    return id;
  }

  function dismiss(id: string): void {
    if (!byId.has(id)) return;
    void spine.capture("inapp.toast_dismissed", { toastId: id });
    remove(id);
  }

  function click(id: string): void {
    const toast = byId.get(id);
    void spine.capture("inapp.toast_clicked", {
      toastId: id,
      ...(toast?.actionUrl ? { actionUrl: toast.actionUrl } : {}),
    });
  }

  return {
    list: () => snapshot,
    show,
    dismiss,
    click,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    teardown: () => {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      byId.clear();
      order.length = 0;
      listeners.clear();
      snapshot = [];
    },
  };
}
