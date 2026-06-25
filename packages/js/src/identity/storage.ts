/**
 * Storage adapters for the identity store. Defaults to `localStorage` when
 * available, falls back to an in-memory adapter (SSR, private mode, native
 * runtimes). All access is guarded so the SSR/memory path never throws.
 */

import type { StorageAdapter } from "../types.js";

/** An in-memory storage adapter (SSR-safe fallback). */
export function createMemoryStorage(): StorageAdapter {
  const map = new Map<string, string>();
  return {
    get: (key) => map.get(key) ?? null,
    set: (key, value) => {
      map.set(key, value);
    },
    remove: (key) => {
      map.delete(key);
    },
  };
}

/** True when a usable `localStorage` is present in this runtime. */
function hasLocalStorage(): boolean {
  try {
    if (typeof localStorage === "undefined") return false;
    const probe = "__hs_probe__";
    localStorage.setItem(probe, probe);
    localStorage.removeItem(probe);
    return true;
  } catch {
    return false;
  }
}

/**
 * A `localStorage`-backed adapter that swallows quota/security errors so a
 * single failing write never breaks identity. Falls through to memory when
 * `localStorage` is unavailable at construction.
 */
export function createLocalStorage(): StorageAdapter {
  if (!hasLocalStorage()) return createMemoryStorage();
  return {
    get: (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set: (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // ignore quota/security failures
      }
    },
    remove: (key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    },
  };
}

/** Resolve the effective storage adapter, honoring an explicit override. */
export function resolveStorage(override?: StorageAdapter): StorageAdapter {
  return override ?? createLocalStorage();
}

/**
 * Generate a UUID v4, preferring `crypto.randomUUID`. Guarded for non-secure
 * contexts (no `crypto`): falls back to a Math.random-based v4 so the
 * SSR/memory path never throws. The fallback is NOT cryptographically strong —
 * it only seeds an anon id, never a security token.
 */
export function generateId(): string {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const rand = (Math.random() * 16) | 0;
    const value = char === "x" ? rand : (rand & 0x3) | 0x8;
    return value.toString(16);
  });
}
