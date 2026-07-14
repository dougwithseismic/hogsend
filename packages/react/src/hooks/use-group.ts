"use client";

/**
 * `useGroup()` — reads the group-association slice reactively and exposes
 * `group`/`resetGroups` bound to the SDK client. ASSOCIATION-ONLY: there is no
 * property write here (group PROPERTIES are a secret-key operation via
 * `@hogsend/client`), so the hook only associates the session with a group and
 * every subsequent capture carries the full `groups` map.
 */

import { useContext } from "react";
import { HogsendContext } from "../provider/context.js";
import { useStoreSelector } from "./use-store.js";

const EMPTY_GROUPS: Record<string, string> = {};

/** Return shape of {@link useGroup}. */
export interface UseGroup {
  /** Current group associations (`groupType → groupKey`), read reactively. */
  groups: Record<string, string>;
  /** Associate the session with a group by its `groupType → groupKey`. */
  group: (groupType: string, groupKey: string) => void;
  /** Clear all group associations. */
  resetGroups: () => void;
}

export function useGroup(): UseGroup {
  const ctx = useContext(HogsendContext);
  if (!ctx) {
    throw new Error("useGroup must be used within <HogsendProvider>");
  }
  const { client } = ctx;

  // Reactive groups slice — stable reference unless the associations change.
  const groups = useStoreSelector(
    client.store,
    (s) => s.groups ?? EMPTY_GROUPS,
  );

  return {
    groups,
    group: (groupType, groupKey) => client.group(groupType, groupKey),
    resetGroups: () => client.resetGroups(),
  };
}
