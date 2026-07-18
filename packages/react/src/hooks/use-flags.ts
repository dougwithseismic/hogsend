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
 *
 * TYPE SURFACE: when the consumer runs `hogsend flags generate` (augmenting
 * `FlagRegistryMap` in `@hogsend/core`), `useFlag` constrains its `key` to a
 * known {@link FlagKey} and narrows the returned value to that flag's served
 * type, and `useFlags` returns the fully-keyed map. UNaugmented, both degrade
 * to today's `string`-key / `unknown`-value surface via
 * {@link IsEmptyFlagRegistry} — EXACTLY like `@hogsend/client`'s
 * `SendEmailInput`. This is a compile-time projection only; runtime behaviour is
 * unchanged (the impls below are the same store selectors as before).
 *
 * `@hogsend/core` is a TYPE-ONLY dependency here — the `import type` is fully
 * erased from the JS dist (mirrors how `@hogsend/client` type-only-imports
 * `@hogsend/email`). We import from the zero-dependency `@hogsend/core/flags-registry`
 * subpath (NOT the main entry) so a browser bundle never drags the engine/db
 * type graph; the consumer's `declare module "@hogsend/core"` augmentation still
 * merges into this same `FlagRegistryMap` interface symbol.
 */

import type {
  FlagKey,
  FlagRegistryMap,
  IsEmptyFlagRegistry,
} from "@hogsend/core/flags-registry";
import { useContext } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const EMPTY_FLAGS: Record<string, unknown> = {};

/**
 * `useFlags` signature: the fully-typed keyed map when the registry is
 * augmented, else today's `Record<string, unknown>`. Deferred conditional — it
 * resolves in the CONSUMER's program (where the `FlagRegistryMap` augmentation
 * is visible), never here.
 */
type UseFlags = IsEmptyFlagRegistry extends true
  ? () => Record<string, unknown>
  : () => { [K in FlagKey]: FlagRegistryMap[K] | undefined };

/**
 * `useFlag` signature: `key` constrained to a known {@link FlagKey} with a
 * narrowed value when augmented, else `(key: string) => unknown`.
 */
type UseFlag = IsEmptyFlagRegistry extends true
  ? (key: string) => unknown
  : <K extends FlagKey>(key: K) => FlagRegistryMap[K] | undefined;

/**
 * The evaluated feature-flag map for the current identity, read reactively.
 * `{}` until the first fetch resolves. Must be used within `<HogsendProvider>`.
 */
function useFlagsImpl(): Record<string, unknown> {
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
function useFlagImpl(key: string): unknown {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useFlag must be used within <HogsendProvider>");
  }
  return useStoreSelector(
    ctx.client.store,
    (s) => (s.flags ?? EMPTY_FLAGS)[key],
  );
}

export const useFlags = useFlagsImpl as unknown as UseFlags;
export const useFlag = useFlagImpl as unknown as UseFlag;
