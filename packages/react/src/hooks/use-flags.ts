"use client";

/**
 * `useFlags()` / `useFlag(key)` — read the native feature-flag slice reactively
 * via `useSyncExternalStore`. The SDK fetches `GET /v1/flags` on init and on
 * identity change and writes the evaluated map into the `flags` slice; these
 * hooks just select against it (no network in the hook — mirrors `useGroup`).
 *
 * Named `flags`/`flag` (never `featureFlag`) so they coexist with PostHog's
 * `useFeatureFlag`. `useFlags` returns the whole map (stable reference unless
 * the map changes); `useFlag` selects a SINGLE value so a component re-renders
 * only when that flag's value changes (`Object.is` bailout).
 */

import { useContext } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const EMPTY_FLAGS: Record<string, unknown> = {};

/**
 * The evaluated feature-flag map for the current identity, read reactively.
 * `{}` until the first fetch resolves. Must be used within `<HogsendProvider>`.
 */
export function useFlags(): Record<string, unknown> {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useFlags must be used within <HogsendProvider>");
  }
  return useStoreSelector(ctx.client.store, (s) => s.flags ?? EMPTY_FLAGS);
}

/**
 * A single flag's evaluated value, read reactively — `undefined` until the
 * first fetch resolves (or when the flag does not exist). Selects the scalar
 * value directly, so a boolean/string flag re-renders only its own consumers.
 * Must be used within `<HogsendProvider>`.
 */
export function useFlag(key: string): unknown {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useFlag must be used within <HogsendProvider>");
  }
  return useStoreSelector(
    ctx.client.store,
    (s) => (s.flags ?? EMPTY_FLAGS)[key],
  );
}
