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
import type { Hogsend, HogsendConfig, Properties } from "./types.js";

/** Async stub shape a page may install before the script loads. */
export interface HogsendStub {
  _q?: unknown[][];
}

declare global {
  interface Window {
    hogsend?: Hogsend | HogsendStub;
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
  /** Injectable fetch (tests). */
  fetch?: typeof fetch;
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
    pageview: d.pageview === "true" || d.pageview === "",
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
export function bootSnippet(opts: SnippetOptions = {}): Hogsend | null {
  // Casts: `resolveConfig` fills missing values from window.__HOGSEND__ /
  // location.origin and throws when nothing resolves; caught below.
  const config: HogsendConfig = {
    apiUrl: opts.host as string,
    publishableKey: opts.key as string,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.userToken ? { userToken: opts.userToken } : {}),
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
    // Cannot set Authorization on EventSource from a browser; poll works.
    realtime: "poll",
  };

  let client: Hogsend;
  try {
    client = createHogsend(config);
  } catch (err) {
    console.warn(
      "[hogsend] not started:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }

  const stub = typeof window !== "undefined" ? window.hogsend : undefined;
  const queued =
    stub && Array.isArray((stub as HogsendStub)._q)
      ? ((stub as HogsendStub)._q as unknown[][])
      : [];

  if (typeof window !== "undefined") window.hogsend = client;

  for (const call of queued) {
    const [method, ...args] = call;
    const fn = (client as unknown as Record<string, unknown>)[String(method)];
    if (typeof fn === "function") {
      try {
        void (fn as (...a: unknown[]) => unknown).apply(client, args);
      } catch (err) {
        console.warn(`[hogsend] queued ${String(method)} failed:`, err);
      }
    } else {
      console.warn(`[hogsend] queued call to unknown method ${String(method)}`);
    }
  }

  if (opts.pageview) void client.capture("$pageview", pageviewProperties());

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
