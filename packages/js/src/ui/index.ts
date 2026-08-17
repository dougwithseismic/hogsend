/**
 * Vanilla DOM renderers for the drop-in script (and any non-React app):
 * a banner slot and a toast stack, driven by the client's own banner/toast
 * sub-clients. No framework, no build step; styles are injected once and keyed
 * off the same `--hs-color-*` tokens `@hogsend/react` uses, so a page themes
 * both the same way.
 *
 * Event story is identical to the React components: `banner.shown` once per
 * banner id on first render, `banner.clicked` / `banner.dismissed` via the
 * banner client, `inapp.toast_*` via the toast client.
 */

import type { Banner } from "../banner/index.js";
import type { Toast } from "../toast/index.js";
import type { Hogsend } from "../types.js";

/** Handle returned by every mount: call `destroy()` to unmount + unsubscribe. */
export interface Mounted {
  destroy(): void;
}

export interface BannerMountOptions {
  /** Banner slot; default `"top"`. */
  slot?: string;
  /** Emit `banner.shown` on first render of a banner. Default true. */
  autoCapture?: boolean;
  /** Label for the dismiss control (a11y). Default "Dismiss". */
  dismissLabel?: string;
}

export interface ToastMountOptions {
  /** Corner to stack in. Default `"bottom-right"`. */
  position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
}

const STYLE_ID = "hs-ui-styles";
const CSS = `
.hs-banner,.hs-toast{box-sizing:border-box;font:14px/1.45 system-ui,sans-serif;color:var(--hs-color-text,#111);background:var(--hs-color-surface,#fff);border:1px solid var(--hs-color-border,#e5e5e5)}
.hs-banner{display:flex;align-items:center;gap:var(--hs-spacing,12px);padding:10px 14px}
.hs-banner__content{flex:1;min-width:0}
.hs-banner__title,.hs-toast__title{font-weight:600}
.hs-banner__body,.hs-toast__body{color:var(--hs-color-text-muted,#555)}
.hs-banner__action,.hs-toast__action{color:var(--hs-color-accent,#2563eb);text-decoration:underline;white-space:nowrap}
.hs-banner__dismiss,.hs-toast__dismiss{all:unset;cursor:pointer;padding:2px 6px;color:var(--hs-color-text-muted,#555);line-height:1}
.hs-toasts{position:fixed;z-index:2147483000;display:flex;flex-direction:column;gap:8px;max-width:360px;pointer-events:none;margin:var(--hs-toast-offset,16px)}
.hs-toasts[data-position$="right"]{right:0}.hs-toasts[data-position$="left"]{left:0}
.hs-toasts[data-position^="top"]{top:0}.hs-toasts[data-position^="bottom"]{bottom:0}
.hs-toast{pointer-events:auto;display:flex;align-items:flex-start;gap:8px;padding:10px 12px;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.12)}
.hs-toast__content{flex:1;min-width:0}
`;

function ensureStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function resolveTarget(target: string | Element): Element | null {
  if (typeof target === "string") return document.querySelector(target);
  return target;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string | null,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text) node.textContent = text;
  return node;
}

/**
 * Render the current banner for a slot into `target` (selector or element).
 * Re-renders on store changes; empty when there is no eligible banner.
 */
export function mountBanner(
  client: Hogsend,
  target: string | Element,
  opts: BannerMountOptions = {},
): Mounted {
  const host = resolveTarget(target);
  if (!host) {
    console.warn("[hogsend] ui.banner: target not found");
    return { destroy() {} };
  }
  ensureStyles();
  const slot = opts.slot ?? "top";
  const banners = client.banners(slot);
  let shownId: string | null = null;
  let current: Banner | null = null;

  const render = (): void => {
    host.replaceChildren();
    if (!current) return;
    const b = current;
    const root = el("div", "hs-banner");
    root.setAttribute("role", "status");
    root.dataset.hsSlot = slot;
    const content = el("div", "hs-banner__content");
    if (b.title) content.appendChild(el("div", "hs-banner__title", b.title));
    if (b.body) content.appendChild(el("div", "hs-banner__body", b.body));
    root.appendChild(content);
    if (b.actionUrl) {
      const a = el("a", "hs-banner__action", "Learn more");
      a.href = b.actionUrl;
      a.addEventListener("click", () => void banners.click(b.id));
      root.appendChild(a);
    }
    const dismiss = el("button", "hs-banner__dismiss", "×");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", opts.dismissLabel ?? "Dismiss");
    dismiss.addEventListener("click", () => void banners.dismiss(b.id));
    root.appendChild(dismiss);
    host.appendChild(root);

    if (opts.autoCapture !== false && shownId !== b.id) {
      shownId = b.id;
      void client.capture("banner.shown", { slot, bannerId: b.id });
    }
  };

  // Derive from the store slice (never refetch inside the listener: `list()`
  // writes the slice, which would re-fire the listener in a loop). One initial
  // fetch fills it; realtime/optimistic patches keep it fresh.
  const derive = (): void => {
    const slice = client.store.getSnapshot().banners?.[slot];
    const next = slice
      ? (slice.order
          .map((id) => slice.byId[id])
          .find((b) => b && !b.dismissed) ?? null)
      : null;
    if (next?.id === current?.id && next?.dismissed === current?.dismissed)
      return;
    current = next;
    render();
  };

  const unsubscribe = banners.on(derive);
  void banners.list().catch(() => {});
  client.connect(`banner:${slot}`);

  return {
    destroy() {
      unsubscribe();
      host.replaceChildren();
    },
  };
}

/**
 * Render the toast stack. `target` defaults to a fixed-position container
 * appended to `document.body`.
 */
export function mountToasts(
  client: Hogsend,
  target?: string | Element,
  opts: ToastMountOptions = {},
): Mounted {
  ensureStyles();
  const toasts = client.toasts();
  // Toasts arrive over the realtime channel; make sure it is open.
  client.connect();
  const own = !target;
  const host = target ? resolveTarget(target) : el("div", "hs-toasts");
  if (!host) {
    console.warn("[hogsend] ui.toasts: target not found");
    return { destroy() {} };
  }
  if (own) {
    (host as HTMLElement).dataset.position = opts.position ?? "bottom-right";
    document.body.appendChild(host);
  }

  const renderOne = (t: Toast): HTMLElement => {
    const root = el("div", "hs-toast");
    root.dataset.hsType = t.type;
    root.setAttribute("role", "status");
    const content = el("div", "hs-toast__content");
    if (t.title) content.appendChild(el("div", "hs-toast__title", t.title));
    if (t.body) content.appendChild(el("div", "hs-toast__body", t.body));
    if (t.actionUrl) {
      const a = el("a", "hs-toast__action", "Open");
      a.href = t.actionUrl;
      a.addEventListener("click", () => toasts.click(t.id));
      content.appendChild(a);
    }
    root.appendChild(content);
    const dismiss = el("button", "hs-toast__dismiss", "×");
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Dismiss");
    dismiss.addEventListener("click", () => toasts.dismiss(t.id));
    root.appendChild(dismiss);
    return root;
  };

  const render = (): void => {
    host.replaceChildren(...toasts.list().map(renderOne));
  };
  const unsubscribe = toasts.subscribe(render);
  render();

  return {
    destroy() {
      unsubscribe();
      if (own) host.remove();
      else host.replaceChildren();
    },
  };
}

/** The `ui` namespace attached to the drop-in client. */
export interface HogsendUi {
  banner(target: string | Element, opts?: BannerMountOptions): Mounted;
  toasts(target?: string | Element, opts?: ToastMountOptions): Mounted;
}

export function createUi(client: Hogsend): HogsendUi {
  return {
    banner: (target, opts) => mountBanner(client, target, opts),
    toasts: (target, opts) => mountToasts(client, target, opts),
  };
}
