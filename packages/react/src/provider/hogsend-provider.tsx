"use client";

/**
 * `HogsendProvider` — instantiates EXACTLY ONE client in a ref-guarded
 * `useState` initializer (strict-mode-double-invoke-safe), re-identifies when
 * `userId` changes, tears down on unmount, and sets `data-hs-color-mode` on its
 * wrapper. The context value is a stable `{ client, color }` — it never churns,
 * so reactive data flows through the store, not context.
 */

import {
  type ColorMode,
  createHogsend,
  type Hogsend,
  type StorageAdapter,
} from "@hogsend/js";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  resolveSystemColorMode,
  watchSystemColorMode,
} from "../hooks/use-color-mode.js";
import { HogsendContext, type HogsendContextValue } from "./context.js";

/** Props for {@link HogsendProvider}. */
export interface HogsendProviderProps {
  apiUrl: string;
  publishableKey: string;
  userId?: string;
  userToken?: string;
  /** "light" | "dark" | "system" (default "system"). */
  colorMode?: ColorMode | "system";
  ingestPath?: string;
  onUserTokenExpiring?: () => Promise<string>;
  /**
   * Injectable `fetch` (SSR / test). Forwarded verbatim to `createHogsend`;
   * lets a test route the SDK's requests into an in-process engine (and inject
   * the browser `Origin` header JS cannot set). Omit in production.
   */
  fetch?: typeof fetch;
  /**
   * Storage backend for the identity slice (`hs_anon_id`). Forwarded verbatim
   * to `createHogsend`; pass `createMemoryStorage()` (or a consent-gated
   * adapter) to keep the SDK from persisting anything until the visitor
   * consents. Omit for the default localStorage-with-memory-fallback.
   * Construction-time only — like the rest of the client config, changing it
   * later requires a remount (key the provider).
   */
  storage?: StorageAdapter;
  children: ReactNode;
}

export function HogsendProvider(props: HogsendProviderProps): ReactNode {
  // One client for the provider's lifetime. The initializer runs twice under
  // strict mode, but `useState` keeps only the first — teardown of the discard
  // is unnecessary because nothing networked starts until an effect runs.
  const [client] = useState<Hogsend>(() =>
    createHogsend({
      apiUrl: props.apiUrl,
      publishableKey: props.publishableKey,
      ...(props.userId ? { userId: props.userId } : {}),
      ...(props.userToken ? { userToken: props.userToken } : {}),
      ...(props.ingestPath ? { ingestPath: props.ingestPath } : {}),
      ...(props.onUserTokenExpiring
        ? { onUserTokenExpiring: props.onUserTokenExpiring }
        : {}),
      ...(props.fetch ? { fetch: props.fetch } : {}),
      ...(props.storage ? { storage: props.storage } : {}),
    }),
  );

  // Re-identify whenever a (truthy) userId changes.
  const lastUserId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (props.userId && props.userId !== lastUserId.current) {
      lastUserId.current = props.userId;
      void client.identify(props.userId);
    }
  }, [client, props.userId]);

  // Teardown on unmount.
  useEffect(() => {
    return () => {
      client.teardown();
    };
  }, [client]);

  // ── color mode ──
  const requested = props.colorMode ?? "system";
  const [resolvedMode, setResolvedMode] = useState<ColorMode>(() =>
    requested === "system" ? resolveSystemColorMode() : requested,
  );

  useEffect(() => {
    if (requested !== "system") {
      setResolvedMode(requested);
      return;
    }
    setResolvedMode(resolveSystemColorMode());
    return watchSystemColorMode(setResolvedMode);
  }, [requested]);

  const setColorMode = useCallback((mode: ColorMode | "system") => {
    setResolvedMode(mode === "system" ? resolveSystemColorMode() : mode);
  }, []);

  const value = useMemo<HogsendContextValue>(
    () => ({
      client,
      color: { colorMode: resolvedMode, setColorMode },
    }),
    [client, resolvedMode, setColorMode],
  );

  return (
    <HogsendContext.Provider value={value}>
      <div data-hs-color-mode={resolvedMode} style={{ display: "contents" }}>
        {props.children}
      </div>
    </HogsendContext.Provider>
  );
}
