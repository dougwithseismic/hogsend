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

  // `lists` (summaries with names) are a v2 addition (a list-catalog read
  // route); v1 surfaces the category map only. Kept in local state so the hook
  // contract is stable now.
  const [lists] = useState<ListSummary[]>([]);
  const [loading, setLoading] = useState(true);

  // Memoized per client lifetime so the effect/callback deps are stable and
  // the fetch effect doesn't re-run on every render.
  const prefsClient = useMemo(() => client.preferences(), [client]);

  const refetch = useCallback(async () => {
    setLoading(true);
    try {
      await prefsClient.get();
    } finally {
      setLoading(false);
    }
  }, [prefsClient]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    prefsClient
      .get()
      .catch(() => undefined)
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [prefsClient]);

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
