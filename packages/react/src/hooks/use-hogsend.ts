"use client";

/**
 * `useHogsend()` — the primary hook. Returns the client plus a reactive slice
 * of identity (bound via `useStoreSelector`, so identity changes re-render this
 * consumer but feed-only changes do not) and the color-mode controls.
 */

import type { Hogsend, Properties } from "@hogsend/js";
import { useCallback, useContext } from "react";
import { HogsendContext } from "../provider/context.js";
import { useColorMode } from "./use-color-mode.js";
import { useStoreSelector } from "./use-store.js";

/** Return shape of {@link useHogsend}. */
export interface UseHogsend {
  client: Hogsend;
  userId: string | null;
  isIdentified: boolean;
  identify: (userId: string, traits?: Properties) => Promise<void>;
  capture: Hogsend["capture"];
  colorMode: "light" | "dark";
  setColorMode: (mode: "light" | "dark" | "system") => void;
}

export function useHogsend(): UseHogsend {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useHogsend must be used within <HogsendProvider>");
  }
  const { client } = ctx;
  const { colorMode, setColorMode } = useColorMode();

  // Scalar selectors — re-render only on identity transitions.
  const userId = useStoreSelector(client.store, (s) => s.identity.userId);
  const isIdentified = useStoreSelector(
    client.store,
    (s) => s.identity.identified,
  );

  const identify = useCallback(
    (id: string, traits?: Properties) => client.identify(id, traits),
    [client],
  );
  const capture = useCallback<Hogsend["capture"]>(
    (event, properties, opts) => client.capture(event, properties, opts),
    [client],
  );

  return {
    client,
    userId,
    isIdentified,
    identify,
    capture,
    colorMode,
    setColorMode,
  };
}
