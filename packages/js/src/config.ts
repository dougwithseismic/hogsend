/**
 * Config resolution: `window.__HOGSEND__` global > explicit opts > inferred
 * origin. Keeps the public {@link HogsendConfig} loose while the rest of the
 * SDK consumes a normalized {@link ResolvedConfig}.
 */

import type { DataLayerConfig, HogsendConfig } from "./types.js";

/** Global config object the host page may set before the SDK loads. */
export interface HogsendGlobal {
  apiUrl?: string;
  host?: string;
  publishableKey?: string;
  ingestPath?: string;
}

declare global {
  var __HOGSEND__: HogsendGlobal | undefined;
}

/** Fully resolved, normalized config the SDK internals consume. */
export interface ResolvedConfig {
  apiUrl: string;
  publishableKey: string;
  userId?: string;
  userToken?: string;
  ingestPath?: string;
  fetch?: typeof fetch;
  realtime: NonNullable<HogsendConfig["realtime"]>;
  flushOnUnload: boolean;
  captureRef: boolean;
  captureAttribution: boolean;
  onUserTokenExpiring?: () => Promise<string>;
  storage?: HogsendConfig["storage"];
  dataLayer?: DataLayerConfig;
}

function readGlobal(): HogsendGlobal {
  if (typeof globalThis === "undefined") return {};
  return globalThis.__HOGSEND__ ?? {};
}

function inferOrigin(): string | undefined {
  if (typeof location !== "undefined" && location.origin)
    return location.origin;
  return undefined;
}

/**
 * Resolve config from the merge chain. Throws when no `apiUrl`/`host` can be
 * determined (neither opts, global, nor a usable origin) or when no
 * `publishableKey` is available.
 */
export function resolveConfig(config: HogsendConfig): ResolvedConfig {
  const glob = readGlobal();

  const apiUrl =
    config.apiUrl ?? config.host ?? glob.apiUrl ?? glob.host ?? inferOrigin();
  if (!apiUrl) {
    throw new Error(
      "@hogsend/js: no apiUrl/host resolved (pass `apiUrl`, set window.__HOGSEND__, or run in a browser origin)",
    );
  }

  const publishableKey = config.publishableKey ?? glob.publishableKey;
  if (!publishableKey) {
    throw new Error(
      "@hogsend/js: no publishableKey resolved (pass `publishableKey` or set window.__HOGSEND__)",
    );
  }

  return {
    apiUrl: apiUrl.replace(/\/+$/, ""),
    publishableKey,
    ...(config.userId ? { userId: config.userId } : {}),
    ...(config.userToken ? { userToken: config.userToken } : {}),
    ...((config.ingestPath ?? glob.ingestPath)
      ? { ingestPath: config.ingestPath ?? glob.ingestPath }
      : {}),
    ...(config.fetch ? { fetch: config.fetch } : {}),
    realtime: config.realtime ?? "sse",
    flushOnUnload: config.flushOnUnload ?? true,
    captureRef: config.captureRef ?? true,
    captureAttribution: config.captureAttribution ?? true,
    ...(config.onUserTokenExpiring
      ? { onUserTokenExpiring: config.onUserTokenExpiring }
      : {}),
    ...(config.storage ? { storage: config.storage } : {}),
    ...(config.dataLayer ? { dataLayer: config.dataLayer } : {}),
  };
}
