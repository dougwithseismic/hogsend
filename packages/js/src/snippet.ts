/**
 * Drop-in `<script>` entry for sites without a bundler.
 *
 * Built as an IIFE (`dist/hogsend.js`) and served first-party by the engine at
 * `GET /hogsend.js`. One tag, zero config:
 *
 *   <script src="https://api.acme.com/hogsend.js" data-key="pk_…"></script>
 *
 * Config comes from the script tag's `data-*` attributes, falling back to
 * `window.__HOGSEND__` (already honoured by `resolveConfig`). `data-host`
 * defaults to the origin the script was loaded from, so pasting the tag is
 * enough. On boot the real client replaces `window.hogsend`; any calls queued
 * on the classic async stub (`window.hogsend = { _q: [] }`) are replayed, and
 * `document` dispatches a `hogsend:ready` CustomEvent with the client.
 */

import { createHogsend } from "./client.js";
import type {
  DataLayerConfig,
  Hogsend,
  HogsendConfig,
  Properties,
} from "./types.js";
import { createUi, type HogsendUi } from "./ui/index.js";

/** What the drop-in puts on `window.hogsend`: the client plus DOM helpers. */
export type HogsendSnippet = Hogsend & { ui: HogsendUi };

/** Async stub shape a page may install before the script loads. */
export interface HogsendStub {
  _q?: unknown[][];
}

declare global {
  interface Window {
    hogsend?: HogsendSnippet | HogsendStub;
  }
}

/** Options read from the script tag (`data-*`) or passed by a test. */
export interface SnippetOptions {
  key?: string;
  host?: string;
  userId?: string;
  userToken?: string;
  /** Capture `$pageview` on boot. Default off. */
  pageview?: boolean;
  /** Mirror captured events onto `window.dataLayer`. Default off. */
  dataLayerPush?: boolean;
  /** Allowlist of `window.dataLayer` event names to ingest. */
  dataLayerWatch?: string[];
  /** Open the realtime channel on boot (feed/toasts). Default off. */
  connect?: boolean;
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
}

/** `data-x` / `data-x=""` / `data-x="true"` all mean on. */
function flag(value: string | undefined): boolean {
  return value === "true" || value === "";
}

/** Read `data-*` options off the currently executing script tag. */
export function readScriptOptions(
  script: HTMLScriptElement | null | undefined,
): SnippetOptions {
  if (!script) return {};
  const d = script.dataset;
  let host = d.host;
  if (!host && script.src) {
    try {
      host = new URL(script.src).origin;
    } catch {
      /* relative/opaque src: fall through to __HOGSEND__ / origin */
    }
  }
  return {
    ...(d.key ? { key: d.key } : {}),
    ...(host ? { host } : {}),
    ...(d.userId ? { userId: d.userId } : {}),
    ...(d.userToken ? { userToken: d.userToken } : {}),
    pageview: flag(d.pageview),
    dataLayerPush: d.datalayer === "push" || d.datalayer === "both",
    ...(d.datalayerWatch
      ? {
          dataLayerWatch: d.datalayerWatch
            .split(",")
            .map((e) => e.trim())
            .filter(Boolean),
        }
      : {}),
    connect: flag(d.connect),
  };
}

function pageviewProperties(): Properties {
  const props: Properties = {};
  if (typeof location !== "undefined") {
    props.$current_url = location.href;
    props.$pathname = location.pathname;
  }
  if (typeof document !== "undefined") {
    if (document.title) props.title = document.title;
    if (document.referrer) props.referrer = document.referrer;
  }
  return props;
}

/**
 * Boot the drop-in client. Returns the client, or `null` (after a
 * `console.warn`) when no publishable key can be resolved. Never throws: a
 * misconfigured tag must not break the host page.
 */
function dataLayerConfig(opts: SnippetOptions): DataLayerConfig | undefined {
  const watch = opts.dataLayerWatch?.length
    ? { events: opts.dataLayerWatch }
    : undefined;
  if (!opts.dataLayerPush && !watch) return undefined;
  return {
    ...(opts.dataLayerPush ? { push: true } : {}),
    ...(watch ? { watch } : {}),
  };
}

export function bootSnippet(opts: SnippetOptions = {}): HogsendSnippet | null {
  const dataLayer = dataLayerConfig(opts);
  // Casts: `resolveConfig` fills missing values from window.__HOGSEND__ /
  // location.origin and throws when nothing resolves; caught below.
  const config: HogsendConfig = {
    apiUrl: opts.host as string,
    publishableKey: opts.key as string,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.userToken ? { userToken: opts.userToken } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    ...(dataLayer ? { dataLayer } : {}),
    // Cannot set Authorization on EventSource from a browser; poll works.
    realtime: "poll",
  };

  const existing = typeof window !== "undefined" ? window.hogsend : undefined;

  // Double embed (tag pasted twice, or a page that already booted a client):
  // keep the live client rather than clobbering it with a second one that
  // would double every capture. A stub is anything without a `capture`.
  if (existing && typeof (existing as Hogsend).capture === "function") {
    console.warn("[hogsend] already booted; ignoring a second script tag");
    return existing as HogsendSnippet;
  }

  let client: HogsendSnippet;
  try {
    const base = createHogsend(config);
    client = Object.assign(base, { ui: createUi(base) });
  } catch (err) {
    console.warn(
      "[hogsend] not started:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const stubQueue = (existing as HogsendStub | undefined)?._q;
  const queued = Array.isArray(stubQueue) ? stubQueue : [];
  if (typeof window !== "undefined") window.hogsend = client;

  for (const call of queued) {
    const [method, ...args] = call;
    const fn = (client as unknown as Record<string, unknown>)[String(method)];
    if (typeof fn !== "function") {
      console.warn(`[hogsend] queued call to unknown method ${String(method)}`);
      continue;
    }
    // Sync throws AND async rejections (identify/flush return promises) are
    // both swallowed with a warning: a bad queued call must not surface as an
    // unhandled rejection on the host page.
    const onError = (err: unknown) =>
      console.warn(`[hogsend] queued ${String(method)} failed:`, err);
    try {
      Promise.resolve(
        (fn as (...a: unknown[]) => unknown).apply(client, args),
      ).catch(onError);
    } catch (err) {
      onError(err);
    }
  }

  if (opts.pageview) void client.capture("$pageview", pageviewProperties());
  if (opts.connect) client.connect();

  if (typeof document !== "undefined" && typeof CustomEvent === "function") {
    document.dispatchEvent(
      new CustomEvent("hogsend:ready", { detail: client }),
    );
  }

  return client;
}

// Auto-boot when loaded as a script tag in a browser.
if (typeof document !== "undefined") {
  bootSnippet(
    readScriptOptions(
      document.currentScript as HTMLScriptElement | null | undefined,
    ),
  );
}
