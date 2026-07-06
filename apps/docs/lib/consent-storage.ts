import type { StorageAdapter } from "@hogsend/js";
import { hasConsented, onConsentChange } from "./analytics";

/**
 * createConsentGatedStorage — a Hogsend `StorageAdapter` that honours the
 * `hs_consent` ledger without ever remounting the provider (a root-level
 * remount would tear down and re-fade the whole page).
 *
 * Pre-consent every read/write lives in an in-memory map, so the SDK works
 * (the bell, the demo feed) but `hs_anon_id` never touches localStorage —
 * matching the PostHog "memory" persistence on the same page. On grant, the
 * buffered entries are flushed to localStorage, so the SAME anon id the
 * session was already using becomes the durable one (id continuity, exactly
 * like PostHog's `set_config` upgrade). On withdraw, the persisted entries
 * are removed and reads fall back to memory.
 */
export function createConsentGatedStorage(): StorageAdapter {
  const memory = new Map<string, string>();

  const canPersist = (): boolean => {
    if (typeof window === "undefined") return false;
    return hasConsented();
  };

  const local = {
    get(key: string): string | null {
      try {
        return window.localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key: string, value: string): void {
      try {
        window.localStorage.setItem(key, value);
      } catch {
        // Quota/private mode — the memory copy still serves this session.
      }
    },
    remove(key: string): void {
      try {
        window.localStorage.removeItem(key);
      } catch {
        // Ignore — nothing persisted means nothing to remove.
      }
    },
  };

  if (typeof window !== "undefined") {
    onConsentChange((status) => {
      if (status === "granted") {
        // Flush the session's buffered identity so it becomes durable.
        for (const [key, value] of memory) local.set(key, value);
      } else {
        // Withdrawn: erase the durable copies; memory keeps the session alive.
        for (const key of memory.keys()) local.remove(key);
      }
    });
  }

  return {
    get(key) {
      if (canPersist()) {
        const stored = local.get(key);
        if (stored !== null) {
          memory.set(key, stored);
          return stored;
        }
      }
      return memory.get(key) ?? null;
    },
    set(key, value) {
      memory.set(key, value);
      if (canPersist()) local.set(key, value);
    },
    remove(key) {
      memory.delete(key);
      if (canPersist()) local.remove(key);
    },
  };
}
