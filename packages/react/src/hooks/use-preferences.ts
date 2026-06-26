"use client";

/**
 * `usePreferences()` — reads the preferences slice reactively and exposes
 * setPreference/subscribe/unsubscribe/refetch. Every write routes through the
 * SDK's preferences client, so each toggle emits `inapp.preference_changed`
 * through the spine (the v1 closed-loop proof) — emission lives in the store
 * mutation, not this hook.
 */

import type { ListSummary, PreferencesState } from "@hogsend/js";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const EMPTY_PREFS: PreferencesState = {
  categories: {},
  unsubscribedAll: false,
};

/** Return shape of {@link usePreferences}. */
export interface UsePreferences {
  preferences: PreferencesState;
  lists: ListSummary[];
  loading: boolean;
  setPreference: (categoryId: string, subscribed: boolean) => Promise<void>;
  subscribe: (listId: string) => Promise<void>;
  unsubscribe: (listId: string) => Promise<void>;
  refetch: () => Promise<void>;
}

export function usePreferences(): UsePreferences {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("usePreferences must be used within <HogsendProvider>");
  }
  const { client } = ctx;

  // Reactive preferences slice — stable reference unless prefs change.
  const preferences = useStoreSelector(
    client.store,
    (s) => s.preferences ?? EMPTY_PREFS,
  );

  // The raw list catalog from `GET /v1/lists` (each list's `subscribed` is the
  // SERVER snapshot at fetch time). Kept raw; the returned `lists` recompute
  // `subscribed` against the live prefs slice below so a toggle reflects
  // instantly without a refetch.
  const [rawLists, setRawLists] = useState<ListSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Memoized per client lifetime so the effect/callback deps are stable and
  // the fetch effect doesn't re-run on every render.
  const prefsClient = useMemo(() => client.preferences(), [client]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([
        prefsClient.get(),
        prefsClient.lists().then(setRawLists),
      ]);
    } finally {
      setLoading(false);
    }
  }, [prefsClient]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      prefsClient.get().catch(() => undefined),
      prefsClient
        .lists()
        .then((next) => {
          if (active) setRawLists(next);
        })
        .catch(() => undefined),
    ]).finally(() => {
      if (active) setLoading(false);
    });
    return () => {
      active = false;
    };
  }, [prefsClient]);

  // Overlay the live prefs slice onto the catalog so a `setPreference` toggle is
  // reflected immediately (`categories[id] ?? defaultOptIn`). Stable unless the
  // catalog or the prefs slice changes.
  const lists = useMemo<ListSummary[]>(
    () =>
      rawLists.map((list) => ({
        ...list,
        subscribed: preferences.categories[list.id] ?? list.defaultOptIn,
      })),
    [rawLists, preferences],
  );

  return {
    preferences,
    lists,
    loading,
    setPreference: (categoryId, subscribed) =>
      prefsClient.setPreference(categoryId, subscribed),
    subscribe: (listId) => prefsClient.subscribe(listId),
    unsubscribe: (listId) => prefsClient.unsubscribe(listId),
    refetch,
  };
}
