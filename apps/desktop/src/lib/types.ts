/**
 * Shapes mirrored from the engine's `GET /v1/health` response
 * (packages/engine/src/routes/health.ts) and the Rust poller's snapshot
 * wrapper (src-tauri/src/lib.rs). Keep these in sync with both ends.
 */

export type ComponentStatus = "up" | "down";

export interface Component {
  status: ComponentStatus;
  latencyMs?: number;
}

export interface WorkerComponent {
  status: ComponentStatus;
  lastSeenAt?: string;
}

export interface SchemaTrack {
  applied: string | null;
  required: string | null;
  inSync: boolean;
  pending: string[];
}

export interface Activity {
  windowHours: number;
  journeys: { failed: number | null; completed: number | null };
  emails: { failed: number | null; sent: number | null };
}

export type HealthStatus = "healthy" | "degraded" | "migration_pending";

export interface Health {
  status: HealthStatus;
  uptime: number;
  timestamp: string;
  version: string;
  components: {
    database: Component;
    redis: Component;
    worker: WorkerComponent;
  };
  schema: { engine: SchemaTrack; client: SchemaTrack };
  activity: Activity;
}

/** Wrapper produced by the Rust poller for a single fetch attempt. */
export interface Snapshot {
  baseUrl: string;
  /** Epoch milliseconds the snapshot was taken. */
  fetchedAt: number;
  ok: boolean;
  health: Health | null;
  error: string | null;
}

/** A saved Hogsend instance the user can monitor. */
export interface Connection {
  id: string;
  /** Origin of the Hogsend API, e.g. https://t.hogsend.com (no trailing /). */
  baseUrl: string;
}
