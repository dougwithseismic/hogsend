import type {
  ConnectorTransport,
  DefinedConnector,
} from "./define-connector.js";
import { PRESET_CONNECTORS } from "./presets/index.js";

/**
 * The process-wide connector registry, set once by `createHogsendClient` at
 * startup. Mirrors {@link DestinationRegistry}: keyed by `meta.id`,
 * last-writer-wins on collision, with a lazy preset-only fallback so a
 * self-booting context (a bare poll cron, a test harness) still resolves the
 * shipped presets even before any container ran.
 *
 * Read by: the webhook route (`getByTransport("webhook")`), the generic
 * `/v1/connectors/:id/*` routes (`get(id)` → `handlers`), the poll-cron
 * registrar, and the gateway launcher.
 */
export class ConnectorRegistry {
  private readonly byId = new Map<string, DefinedConnector>();

  constructor(connectors: DefinedConnector[] = []) {
    for (const connector of connectors) {
      this.byId.set(connector.meta.id, connector);
    }
  }

  /** Register / overwrite a connector (last-writer-wins). */
  register(connector: DefinedConnector): void {
    this.byId.set(connector.meta.id, connector);
  }

  /**
   * Remove a connector by id (no-op when absent). Used by the deprecated
   * `createApp({ enablePresets: false })` strip path to suppress env presets the
   * container already installed.
   */
  unregister(id: string): boolean {
    return this.byId.delete(id);
  }

  get(id: string): DefinedConnector | undefined {
    return this.byId.get(id);
  }

  getAll(): DefinedConnector[] {
    return [...this.byId.values()];
  }

  /** Every connector whose (defaulted) transport matches. */
  getByTransport(transport: ConnectorTransport): DefinedConnector[] {
    return this.getAll().filter(
      (c) => (c.meta.transport ?? "webhook") === transport,
    );
  }

  count(): number {
    return this.byId.size;
  }
}

let fallback: ConnectorRegistry | undefined;
let installed: ConnectorRegistry | undefined;

export function setConnectorRegistry(registry: ConnectorRegistry): void {
  installed = registry;
}

export function getConnectorRegistry(): ConnectorRegistry {
  if (installed) return installed;
  if (!fallback) {
    fallback = new ConnectorRegistry(Object.values(PRESET_CONNECTORS));
  }
  return fallback;
}

/** Reset the installed registry — only for test cleanup. */
export function resetConnectorRegistry(): void {
  installed = undefined;
}
