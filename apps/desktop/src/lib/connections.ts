import type { Connection } from "./types";

/**
 * Connection list persistence. Connections are non-secret (just a label + the
 * public API origin), so localStorage is sufficient and keeps the UI snappy.
 * Auth itself lives in the Studio webview's first-party cookies, never here.
 */

const CONNECTIONS_KEY = "hogsend.connections";
const ACTIVE_KEY = "hogsend.activeConnectionId";

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function loadConnections(): Connection[] {
  return read<Connection[]>(CONNECTIONS_KEY, []);
}

export function saveConnections(connections: Connection[]): void {
  localStorage.setItem(CONNECTIONS_KEY, JSON.stringify(connections));
}

export function getActiveId(): string | null {
  return read<string | null>(ACTIVE_KEY, null);
}

export function setActiveId(id: string | null): void {
  if (id === null) localStorage.removeItem(ACTIVE_KEY);
  else localStorage.setItem(ACTIVE_KEY, JSON.stringify(id));
}

/** Strip a trailing slash so paths concatenate cleanly. */
export function normalizeBaseUrl(input: string): string {
  return input.trim().replace(/\/+$/, "");
}

export function createConnection(baseUrl: string): Connection {
  return {
    id: crypto.randomUUID(),
    baseUrl: normalizeBaseUrl(baseUrl),
  };
}

/** Human label for a connection — just the host (e.g. "t.hogsend.com"). */
export function connectionLabel(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

/** Suggested first instance — the dogfood engine. */
export const DEFAULT_BASE_URL = "https://t.hogsend.com";
