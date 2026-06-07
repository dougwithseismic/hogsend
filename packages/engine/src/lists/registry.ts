import { parseEnabledFilter } from "../journeys/registry.js";
import type { DefinedList, ListMeta } from "./define-list.js";
import { setListRegistry } from "./registry-singleton.js";

/**
 * In-process index of the defined email lists (D3). Mirrors `BucketRegistry` /
 * `JourneyRegistry`: a plain id-keyed map plus the polarity helpers that are the
 * SINGLE SOURCE OF TRUTH for "is this category subscribed", consumed by the
 * mailer's suppression check AND the preference-center render so the two never
 * drift.
 *
 * A list shares the `email_preferences.categories` JSONB key namespace with the
 * built-in `transactional`/`journey` categories. The registry only knows about
 * defined lists — an UNKNOWN id resolves to legacy opt-in behaviour via
 * {@link ListRegistry.isSubscribedByDefault} (`?? true`).
 */
export class ListRegistry {
  private lists: Map<string, ListMeta> = new Map();

  register(list: ListMeta): void {
    this.lists.set(list.id, list);
  }

  get(id: string): ListMeta | undefined {
    return this.lists.get(id);
  }

  getAll(): ListMeta[] {
    return Array.from(this.lists.values());
  }

  getEnabled(): ListMeta[] {
    return this.getAll().filter((l) => l.enabled);
  }

  has(id: string): boolean {
    return this.lists.has(id);
  }

  count(): number {
    return this.lists.size;
  }

  /**
   * The list's default polarity. An unknown id (not a defined list — e.g. a
   * built-in `transactional`/`journey` category, or a stale list) defaults to
   * `true` (opt-in), preserving legacy behaviour: blocked only on explicit
   * `false`.
   */
  isSubscribedByDefault(id: string): boolean {
    return this.get(id)?.defaultOptIn ?? true;
  }

  /**
   * The LOCKED polarity rule (§2.6). Given the stored `categories` map and a
   * category id, decide whether the recipient is subscribed:
   *  - opt-in default (`defaultOptIn true`): subscribed unless explicitly `false`
   *  - opt-out default (`defaultOptIn false`): subscribed only when explicitly `true`
   *
   * Unknown ids fall through to opt-in default (via
   * {@link ListRegistry.isSubscribedByDefault}), matching legacy semantics.
   */
  isSubscribed(categories: Record<string, boolean>, id: string): boolean {
    const defaultOptIn = this.isSubscribedByDefault(id);
    return defaultOptIn ? categories[id] !== false : categories[id] === true;
  }
}

/**
 * Build a {@link ListRegistry} from an injected array of lists, applying the
 * enabled filter, and install it as the process singleton (so the mailer's
 * suppression check and the preference center can resolve it). Returns the
 * registry.
 *
 * `parseEnabledFilter` (journeys/registry.ts) is reused as-is — `ENABLED_LISTS`
 * honours the same `"*"`-or-csv contract as `ENABLED_JOURNEYS` /
 * `ENABLED_BUCKETS`. Disabled lists (filtered out OR `enabled: false`) are NOT
 * registered, so an unknown id resolves to legacy opt-in.
 */
export function buildListRegistry(
  lists: DefinedList[],
  enabledFilter?: string,
): ListRegistry {
  const registry = new ListRegistry();
  const enabled = parseEnabledFilter(enabledFilter);

  for (const list of lists) {
    if (enabled === "*" || enabled.has(list.meta.id)) {
      registry.register(list.meta);
    }
  }

  setListRegistry(registry);
  return registry;
}
