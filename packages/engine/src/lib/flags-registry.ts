import type { DefinedFlag } from "@hogsend/core";
import type { Logger } from "./logger.js";
import { createOptionalSingleton } from "./singleton.js";

/**
 * Registry of code-defined feature flags ({@link defineFlag}), the flag sibling
 * of `ConversionRegistry`. Indexed by `meta.key`; a duplicate key warns and is
 * skipped (first definition wins) so one fat-fingered copy-paste never silently
 * shadows another flag. Constructed by `createHogsendClient` from `opts.flags`
 * and installed on the process singleton so the boot reconciler + Studio can
 * read it without a client reference.
 */
export class FlagRegistry {
  private byKey = new Map<string, DefinedFlag>();

  constructor(definitions: DefinedFlag[] = [], logger?: Logger) {
    for (const def of definitions) {
      const key = def.meta.key;
      if (this.byKey.has(key)) {
        logger?.warn("flags: duplicate defineFlag key — skipping", { key });
        continue;
      }
      this.byKey.set(key, def);
    }
  }

  get(key: string): DefinedFlag | undefined {
    return this.byKey.get(key);
  }

  has(key: string): boolean {
    return this.byKey.has(key);
  }

  getAll(): DefinedFlag[] {
    return [...this.byKey.values()];
  }

  count(): number {
    return this.byKey.size;
  }
}

const singleton = createOptionalSingleton<FlagRegistry>();
export const setFlagRegistry = singleton.set;
export const getFlagRegistry = singleton.get;
/** Reset the singleton — only for test cleanup. */
export const resetFlagRegistry = singleton.reset;
