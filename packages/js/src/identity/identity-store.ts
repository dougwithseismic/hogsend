/**
 * Identity management: anon-id generation/persistence, identify, contactKey
 * reconciliation, and reset. Pushes every change into the reactive store's
 * `identity` slice so React selectors re-render on identity transitions.
 */

import type { Store } from "../store/external-store.js";
import type { HogsendState, IdentitySlice, StorageAdapter } from "../types.js";
import { generateId, resolveStorage } from "./storage.js";

/** localStorage key for the persisted anonymous id. */
export const ANON_ID_KEY = "hs_anon_id";

export interface IdentityStoreOptions {
  store: Store<HogsendState>;
  storage?: StorageAdapter;
  /** Known user id from config (optional). */
  userId?: string;
}

/** The identity sub-store. */
export interface IdentityStore {
  /** Resolved distinct id (known userId, else persisted anon id). */
  getDistinctId(): string;
  /** Known user id when identified, else null. */
  getUserId(): string | null;
  /** Persisted anonymous id (always present). */
  getAnonymousId(): string;
  /** Canonical contact key from the last 202, else null. */
  getContactKey(): string | null;
  isIdentified(): boolean;
  /** Bind a known user id (anon→known fold happens server-side). */
  setUserId(userId: string): void;
  /** Record the canonical contact key returned by an ingest 202. */
  setContactKey(contactKey: string): void;
  /** Logout: mint a new anon id, drop the known id + contact key. */
  reset(): void;
}

function readSlice(
  storage: StorageAdapter,
  userId: string | null,
): IdentitySlice {
  let anonymousId = storage.get(ANON_ID_KEY);
  if (!anonymousId) {
    anonymousId = generateId();
    storage.set(ANON_ID_KEY, anonymousId);
  }
  return {
    distinctId: userId ?? anonymousId,
    userId,
    contactKey: null,
    identified: userId !== null,
  };
}

/** Create an identity store seeded from storage + config. */
export function createIdentityStore(opts: IdentityStoreOptions): IdentityStore {
  const storage = resolveStorage(opts.storage);
  const initialUserId = opts.userId ?? null;
  const slice = readSlice(storage, initialUserId);
  opts.store.setState((prev) => ({ ...prev, identity: slice }));

  function current(): IdentitySlice {
    return opts.store.getSnapshot().identity;
  }

  function patch(next: Partial<IdentitySlice>): void {
    opts.store.setState((prev) => ({
      ...prev,
      identity: { ...prev.identity, ...next },
    }));
  }

  function anonId(): string {
    const existing = storage.get(ANON_ID_KEY);
    if (existing) return existing;
    const minted = generateId();
    storage.set(ANON_ID_KEY, minted);
    return minted;
  }

  return {
    getDistinctId: () => current().distinctId,
    getUserId: () => current().userId,
    getAnonymousId: anonId,
    getContactKey: () => current().contactKey,
    isIdentified: () => current().identified,
    setUserId: (userId) => {
      patch({ userId, distinctId: userId, identified: true });
    },
    setContactKey: (contactKey) => {
      patch({ contactKey });
    },
    reset: () => {
      storage.remove(ANON_ID_KEY);
      const fresh = anonId();
      patch({
        userId: null,
        distinctId: fresh,
        contactKey: null,
        identified: false,
      });
    },
  };
}
