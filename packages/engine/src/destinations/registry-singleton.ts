import type { DefinedDestination } from "./define-destination.js";
import { PRESET_DESTINATIONS } from "./presets/index.js";

/**
 * The process-wide destination registry, set once by `createHogsendClient` at
 * startup and read by the delivery task (`workflows/deliver-webhook.ts`) to
 * resolve a transform by `endpoint.kind`.
 *
 * Why a singleton (mirrors `lib/analytics-singleton.ts`): the durable
 * `deliverWebhookTask` SELF-BOOTS — it opens its own `getDb()` from
 * `process.env` and has NO client/container reference. So the registered
 * transforms (presets + the consumer's `defineDestination()` destinations) MUST
 * be reachable via a process singleton, exactly as analytics / the journey +
 * bucket registries are. `createHogsendClient` runs in BOTH the API and worker,
 * so by the time any worker task executes the registry has been installed.
 *
 * Resilient default: if a delivery task somehow runs in a process that never
 * called `createHogsendClient` (a bare reaper re-drive in a test harness), the
 * getter lazily falls back to the shipped {@link PRESET_DESTINATIONS} so the
 * no-regression `webhook` + the `posthog` presets still resolve. Installing a
 * registry via {@link setDestinationRegistry} replaces this fallback.
 */
export class DestinationRegistry {
  private readonly byKind = new Map<string, DefinedDestination>();

  constructor(destinations: DefinedDestination[] = []) {
    for (const destination of destinations) {
      // Last-writer-wins on id collision — the caller (container) orders the
      // array so the consumer's destination wins over a preset of the same id.
      this.byKind.set(destination.meta.id, destination);
    }
  }

  /** Resolve a destination by its `kind` id, or `undefined` when unregistered. */
  get(kind: string): DefinedDestination | undefined {
    return this.byKind.get(kind);
  }

  /** Every registered destination (for diagnostics / catalog enumeration). */
  getAll(): DefinedDestination[] {
    return [...this.byKind.values()];
  }

  /** Number of registered destinations. */
  count(): number {
    return this.byKind.size;
  }
}

/** The lazily-built fallback registry of just the shipped presets. */
let fallback: DestinationRegistry | undefined;
let installed: DestinationRegistry | undefined;

/**
 * Install the resolved destination registry. Called by `createHogsendClient`
 * after merging the env presets with the consumer's `opts.destinations`.
 */
export function setDestinationRegistry(registry: DestinationRegistry): void {
  installed = registry;
}

/**
 * Read the destination registry. Returns the installed registry, or a lazily
 * built preset-only fallback so a self-booting task always resolves the
 * always-on `webhook` + `posthog` presets even before any container ran.
 */
export function getDestinationRegistry(): DestinationRegistry {
  if (installed) return installed;
  if (!fallback) {
    fallback = new DestinationRegistry(Object.values(PRESET_DESTINATIONS));
  }
  return fallback;
}

/** Reset the installed registry — only for test cleanup. */
export function resetDestinationRegistry(): void {
  installed = undefined;
}
