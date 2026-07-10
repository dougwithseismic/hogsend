import type { Database } from "@hogsend/db";
import type { Logger } from "../../lib/logger.js";
import { type LoadedSpec, loadJourneySpecsFromDb } from "./load-from-db.js";

/**
 * In-memory index of the currently-active DB journey specs (Slice 2). This is
 * what `ingestEvent` consults to dispatch a spec's generic runner and to
 * evaluate a spec's `exitOn` — WITHOUT a worker restart, which is the whole
 * point of the runtime path.
 *
 * It is a CACHE, not a source of truth: the runner receives the spec snapshot in
 * its dispatch input (replay-deterministic), so a stale store only affects WHICH
 * enrollments start, never how an in-flight run replays. `refreshIfStale` reloads
 * at most once per TTL from the ingest hot path (a timestamp compare, one SELECT
 * when due), and `markStale` lets the admin write path force the next refresh.
 */
export class RuntimeSpecStore {
  private byId = new Map<string, LoadedSpec>();
  private byTrigger = new Map<string, LoadedSpec[]>();
  private lastRefreshedAt = 0;
  private inFlight: Promise<void> | null = null;

  /**
   * Reload from the DB and rebuild both indexes. Concurrency-safe: overlapping
   * callers share the one in-flight load rather than hammering the DB.
   */
  async refresh(db: Database, nowMs: number, logger?: Logger): Promise<void> {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const specs = await loadJourneySpecsFromDb({ db, logger });
        const byId = new Map<string, LoadedSpec>();
        const byTrigger = new Map<string, LoadedSpec[]>();
        for (const loaded of specs) {
          byId.set(loaded.spec.id, loaded);
          const event = loaded.spec.meta.trigger.event;
          const list = byTrigger.get(event) ?? [];
          list.push(loaded);
          byTrigger.set(event, list);
        }
        this.byId = byId;
        this.byTrigger = byTrigger;
        this.lastRefreshedAt = nowMs;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  /** Refresh only when the cache is older than `ttlMs` (cheap on the hot path). */
  async refreshIfStale(
    db: Database,
    nowMs: number,
    ttlMs: number,
    logger?: Logger,
  ): Promise<void> {
    if (nowMs - this.lastRefreshedAt < ttlMs) return;
    await this.refresh(db, nowMs, logger);
  }

  /** Force the next `refreshIfStale` to reload (admin write path). */
  markStale(): void {
    this.lastRefreshedAt = 0;
  }

  getByTriggerEvent(event: string): LoadedSpec[] {
    return this.byTrigger.get(event) ?? [];
  }

  getById(id: string): LoadedSpec | undefined {
    return this.byId.get(id);
  }

  all(): LoadedSpec[] {
    return [...this.byId.values()];
  }

  size(): number {
    return this.byId.size;
  }
}

/**
 * Default TTL for the ingest hot-path `refreshIfStale`. A newly-written spec goes
 * live within this window without a restart; override with
 * `RUNTIME_SPEC_REFRESH_MS`. The admin write path calls `markStale()` so the API
 * process sees an edit immediately regardless of TTL.
 */
export function runtimeSpecRefreshMs(): number {
  const raw = Number(process.env.RUNTIME_SPEC_REFRESH_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
}

// Lazy process singleton: `get` creates the store on first read so any ingest
// path resolves one even in a minimal test harness that never booted a full
// container. `createHogsendClient` refreshes it at boot.
let _store: RuntimeSpecStore | undefined;

export function getRuntimeSpecStore(): RuntimeSpecStore {
  if (!_store) _store = new RuntimeSpecStore();
  return _store;
}

/** Test-only reset. */
export function resetRuntimeSpecStore(): void {
  _store = undefined;
}
