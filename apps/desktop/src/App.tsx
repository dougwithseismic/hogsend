import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoLogin, ConnectionPicker } from "./components/Connections";
import { HealthDashboard } from "./components/HealthDashboard";
import {
  fetchHealthNow,
  onHealthUpdate,
  openStudio,
  setActiveConnection,
} from "./lib/bridge";
import {
  getActiveId,
  loadConnections,
  saveConnections,
  setActiveId,
} from "./lib/connections";
import type { Connection, Snapshot } from "./lib/types";

export function App() {
  const [connections, setConnections] = useState<Connection[]>(loadConnections);
  const [activeId, setActive] = useState<string | null>(getActiveId);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);

  const active = useMemo(
    () => connections.find((c) => c.id === activeId) ?? null,
    [connections, activeId],
  );

  // Persist connection list whenever it changes.
  useEffect(() => {
    saveConnections(connections);
  }, [connections]);

  // Stream snapshots emitted by the Rust poller.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onHealthUpdate((snap) => {
      // Ignore stragglers from a previously-active connection.
      if (!active || snap.baseUrl === active.baseUrl) {
        setSnapshot(snap);
        setLoading(false);
      }
    }).then((fn) => {
      unlisten = fn;
    });
    return () => unlisten?.();
  }, [active]);

  // Point the poller at the active connection (or idle it) on change.
  useEffect(() => {
    setActiveId(activeId);
    setSnapshot(null);
    if (active) {
      setLoading(true);
      setActiveConnection(active.baseUrl);
    } else {
      setActiveConnection(null);
    }
  }, [active, activeId]);

  // Launch straight into Studio for the saved instance, once, on first load.
  const launched = useRef(false);
  useEffect(() => {
    if (launched.current || !active) return;
    launched.current = true;
    openStudio(active.baseUrl);
  }, [active]);

  const refresh = useCallback(async () => {
    if (!active) return;
    setLoading(true);
    try {
      setSnapshot(await fetchHealthNow());
    } finally {
      setLoading(false);
    }
  }, [active]);

  // Selecting an instance is "open it" — Studio is the main surface.
  const selectConnection = useCallback(
    (id: string) => {
      setActive(id);
      const conn = connections.find((c) => c.id === id);
      if (conn) openStudio(conn.baseUrl);
    },
    [connections],
  );

  const addConnection = useCallback((conn: Connection) => {
    setConnections((prev) => [...prev, conn]);
    setActive(conn.id);
    openStudio(conn.baseUrl);
  }, []);

  const removeConnection = useCallback((id: string) => {
    setConnections((prev) => prev.filter((c) => c.id !== id));
    setActive((curr) => (curr === id ? null : curr));
  }, []);

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      <header
        data-tauri-drag-region
        className="flex items-center justify-between border-b border-neutral-800 px-4 pb-2.5 pt-3"
      >
        <div className="flex items-center gap-2">
          <span className="text-base">🦔</span>
          <span className="text-sm font-semibold tracking-tight">Hogsend</span>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={!active}
          className="text-neutral-500 hover:text-neutral-200 disabled:opacity-30"
          aria-label="Refresh"
          title="Refresh"
        >
          ↻
        </button>
      </header>

      <main className="flex-1 space-y-4 overflow-y-auto px-4 py-3">
        <ConnectionPicker
          connections={connections}
          activeId={activeId}
          onSelect={selectConnection}
          onAdd={addConnection}
          onRemove={removeConnection}
        />

        {active && (
          <>
            <button
              type="button"
              onClick={() => openStudio(active.baseUrl)}
              className="w-full rounded-lg bg-neutral-200 px-3 py-2 text-sm font-medium text-neutral-900 hover:bg-white"
            >
              Open Studio →
            </button>
            <AutoLogin baseUrl={active.baseUrl} />
            <div className="border-t border-neutral-800" />
            <HealthDashboard snapshot={snapshot} loading={loading} />
          </>
        )}
      </main>
    </div>
  );
}
