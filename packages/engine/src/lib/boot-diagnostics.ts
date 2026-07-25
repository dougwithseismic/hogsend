/**
 * Process-global boot diagnostics collector.
 *
 * A boot diagnostic is a machine-readable record of a detected-but-non-fatal
 * misconfiguration (`email.no-provider`, `plugin.load-failed:…`, `sms.no-sender`,
 * …). The engine already warns about these on stdout, but stdout is only
 * visible to whoever tails that process — this collector is the queryable
 * second channel that `/v1/health` (count only) and `/v1/admin/config` (full
 * detail) read from, so an inert deployment is distinguishable from a healthy
 * one over the wire.
 *
 * This is a MODULE-LEVEL SINGLETON, not container state, on purpose. The
 * motivating failure — the opt-in plugin loaders in
 * `{enrichment,email,sms}-providers-from-env.ts` — records at module scope
 * under top-level `await`, before any container exists. A collector threaded
 * through `createHogsendClient` structurally cannot see those recordings.
 * Boot diagnostics ARE process-global state; modelling them otherwise loses
 * the exact case this module exists for.
 */

export interface BootDiagnostic {
  /**
   * Stable, namespaced, machine-readable identifier — the dedupe key. A
   * per-source condition must bake the source into the code
   * (`contact-source.no-secret:<id>`) so two instances yield two entries.
   */
  code: string;
  /** Human-readable detail; admin-only over the wire (it can name env vars). */
  message: string;
}

/**
 * Keyed by `code` because `createHogsendClient` runs more than once per
 * process (API + worker in dev, repeatedly across a test file) — a plain
 * append would report the same problem N times. A `Map` re-set keeps the
 * FIRST insertion's position, so re-recording is fully idempotent: the entry
 * neither duplicates nor migrates to the end of the iteration order.
 */
const diagnostics = new Map<string, BootDiagnostic>();

/** Record (or refresh — last write wins per code) a boot diagnostic. */
export function recordBootDiagnostic(d: BootDiagnostic): void {
  diagnostics.set(d.code, d);
}

/**
 * Snapshot of every recorded diagnostic in first-record insertion order.
 * Returns a fresh array each call — the collector is long-lived process
 * state, so handing out the live backing store would let any reader corrupt
 * what every other surface reports.
 */
export function getBootDiagnostics(): readonly BootDiagnostic[] {
  return [...diagnostics.values()];
}

/**
 * TEST-ONLY. Empties the collector so tests don't observe each other's
 * recordings. Never call this in production code: module-scope recordings
 * (the opt-in plugin loaders) fire exactly once per process — modules never
 * re-evaluate — so clearing permanently discards those entries for the rest
 * of the process. Tests must therefore assert on codes they recorded
 * themselves (or deltas), never on absolute collector counts.
 */
export function clearBootDiagnostics(): void {
  diagnostics.clear();
}
