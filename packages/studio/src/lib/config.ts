/**
 * Runtime configuration for the Studio SPA.
 *
 * The Studio can be served in two ways:
 *  - Mounted by the engine at /studio (same-origin) — `baseUrl` is "" so all
 *    requests hit the same host that served the app.
 *  - Standalone via the `hogsend studio` CLI pointed at a remote instance —
 *    the CLI can inject `window.__HOGSEND_STUDIO__ = { baseUrl }` into the
 *    served index.html, or set VITE_HOGSEND_BASE_URL at build time.
 *
 * Resolution order: runtime global > build-time env > same-origin ("").
 */
declare global {
  interface Window {
    __HOGSEND_STUDIO__?: {
      baseUrl?: string;
    };
  }
}

function resolveBaseUrl(): string {
  if (typeof window !== "undefined" && window.__HOGSEND_STUDIO__?.baseUrl) {
    return window.__HOGSEND_STUDIO__.baseUrl.replace(/\/$/, "");
  }
  const envBase = import.meta.env.VITE_HOGSEND_BASE_URL;
  if (envBase) {
    return envBase.replace(/\/$/, "");
  }
  return "";
}

export const config = {
  /** Origin (or origin prefix) of the Hogsend API. "" means same-origin. */
  baseUrl: resolveBaseUrl(),
} as const;
