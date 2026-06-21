import type { DefinedConnectorAction } from "./define-action.js";

/**
 * The process-wide connector-action registry, set once by `createHogsendClient`.
 * Mirrors {@link ConnectorRegistry}: keyed by `${connectorId}:${name}`,
 * last-writer-wins, with a lazy empty fallback so a self-booting context (the
 * standalone {@link sendConnectorAction}) resolves cleanly even before any
 * container ran (it just finds no actions).
 */
export class ConnectorActionRegistry {
  private readonly byKey = new Map<string, DefinedConnectorAction>();

  constructor(actions: DefinedConnectorAction[] = []) {
    for (const action of actions) this.register(action);
  }

  register(action: DefinedConnectorAction): void {
    this.byKey.set(`${action.connectorId}:${action.name}`, action);
  }

  get(connectorId: string, name: string): DefinedConnectorAction | undefined {
    return this.byKey.get(`${connectorId}:${name}`);
  }

  getAll(): DefinedConnectorAction[] {
    return [...this.byKey.values()];
  }

  count(): number {
    return this.byKey.size;
  }
}

let installed: ConnectorActionRegistry | undefined;
let fallback: ConnectorActionRegistry | undefined;

export function setConnectorActionRegistry(
  registry: ConnectorActionRegistry,
): void {
  installed = registry;
}

export function getConnectorActionRegistry(): ConnectorActionRegistry {
  if (installed) return installed;
  if (!fallback) fallback = new ConnectorActionRegistry();
  return fallback;
}

/** Reset the installed registry — only for test cleanup. */
export function resetConnectorActionRegistry(): void {
  installed = undefined;
}
