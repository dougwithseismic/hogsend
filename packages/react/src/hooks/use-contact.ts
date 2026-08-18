"use client";

/**
 * `useContact()` / `useTrait(key)` — read the allowlisted contact projection
 * reactively via `useSyncExternalStore`. The SDK fetches `GET /v1/contacts/me`
 * on init, on identity change, and after `identify()` resolves, and writes the
 * result into the `contact` slice; these hooks just select against it (no
 * network in the hook — mirrors `useFlags`).
 *
 * Only traits the OPERATOR put on the engine's `contacts.publicProperties`
 * allowlist are present, and `email` only when `contacts.exposeEmail` is on.
 * The default allowlist is empty, so an unconfigured deploy reads `{}`.
 *
 * TYPE SURFACE: when the consumer augments `ContactTraitsMap` in
 * `@hogsend/core`, `useTrait` constrains its `key` to a known {@link TraitKey}
 * and narrows the returned value, and `useContact` returns the fully-keyed
 * trait map. UNaugmented, both degrade to the `string`-key / `unknown`-value
 * surface via {@link IsEmptyTraitsMap}. Compile-time projection only; the
 * runtime impls below are plain store selectors.
 *
 * `@hogsend/core` is a TYPE-ONLY dependency here — the `import type` is fully
 * erased from the JS dist. We import from the zero-dependency
 * `@hogsend/core/contact-traits` subpath (NOT the main entry) so a browser
 * bundle never drags the engine/db type graph; the consumer's
 * `declare module "@hogsend/core"` augmentation still merges into this same
 * `ContactTraitsMap` interface symbol.
 */

import type {
  ContactTraitsMap,
  IsEmptyTraitsMap,
  TraitKey,
} from "@hogsend/core/contact-traits";
import { useContext, useMemo } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const EMPTY_TRAITS: Record<string, unknown> = {};

/** What {@link useContact} returns, with the trait map typed by the registry. */
export interface UseContactResult<TTraits = Record<string, unknown>> {
  /** The allowlisted traits. `{}` until the first fetch resolves. */
  traits: TTraits;
  /**
   * `true` only for a contact carrying an externalId or an email — an
   * anonymous visitor (or an anon-only row) reads `false`.
   */
  identified: boolean;
  /** The contact's email, present only when the operator exposed it. */
  email: string | null | undefined;
  /** `true` until the first `GET /v1/contacts/me` resolves. */
  loading: boolean;
}

/**
 * `useContact` signature: the fully-typed trait map when the registry is
 * augmented, else today's `Record<string, unknown>`. Deferred conditional — it
 * resolves in the CONSUMER's program (where the augmentation is visible).
 */
type UseContact = IsEmptyTraitsMap extends true
  ? () => UseContactResult<Record<string, unknown>>
  : () => UseContactResult<{
      [K in TraitKey]: ContactTraitsMap[K] | undefined;
    }>;

/**
 * `useTrait` signature: `key` constrained to a known {@link TraitKey} with a
 * narrowed value when augmented, else `(key: string) => unknown`.
 */
type UseTrait = IsEmptyTraitsMap extends true
  ? (key: string) => unknown
  : <K extends TraitKey>(key: K) => ContactTraitsMap[K] | undefined;

/**
 * The allowlisted contact projection for the current identity, read
 * reactively. Must be used within `<HogsendProvider>`.
 */
function useContactImpl(): UseContactResult {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useContact must be used within <HogsendProvider>");
  }
  // Select the SLICE (a stable reference the client replaces wholesale on
  // each write), then derive the fields outside the selector — building the
  // result object inside would mint a new object every read and loop
  // `useSyncExternalStore`.
  const slice = useStoreSelector(ctx.client.store, (s) => s.contact);
  // Memoized on the slice so the returned object is referentially stable
  // across renders (matches `useFlags`, which returns the slice itself).
  return useMemo(
    () => ({
      traits: slice?.traits ?? EMPTY_TRAITS,
      identified: slice?.identified ?? false,
      email: slice?.email,
      loading: slice === undefined,
    }),
    [slice],
  );
}

/**
 * A single trait's value, read reactively — `undefined` until the first fetch
 * resolves, or when the key is not on the operator's allowlist. Selects the
 * scalar directly, so a component re-renders only when THAT trait changes
 * (`Object.is` bailout). Must be used within `<HogsendProvider>`.
 */
function useTraitImpl(key: string): unknown {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useTrait must be used within <HogsendProvider>");
  }
  return useStoreSelector(
    ctx.client.store,
    (s) => (s.contact?.traits ?? EMPTY_TRAITS)[key],
  );
}

export const useContact = useContactImpl as unknown as UseContact;
export const useTrait = useTraitImpl as unknown as UseTrait;
