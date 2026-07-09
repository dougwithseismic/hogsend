import { type Database, journeyLogs } from "@hogsend/db";

/**
 * The transition-log action vocabulary. These strings are written verbatim to
 * `journey_logs.action` (a free-text column) and read by the Studio instance
 * drawer timeline + the Phase-3 per-node *reached* funnel. Keep them in lockstep
 * with the graph extractor's node semantics.
 */
export type JourneyLogAction =
  | "entered"
  | "sleep"
  | "wait"
  | "resume"
  | "checkpoint"
  | "send"
  | "trigger"
  | "completed"
  | "failed"
  | "exited";

export interface LogTransitionArgs {
  db: Database;
  journeyStateId: string;
  /** Source node id (best-effort; null/undefined when unknown or not tracked). */
  from?: string | null;
  /** Destination node id (the node reached by this transition). */
  to?: string | null;
  action: JourneyLogAction;
  detail?: Record<string, unknown>;
}

/**
 * Best-effort, STRICTLY fire-and-forget transition log. Inserts one
 * `journey_logs` row for observability.
 *
 * SAFETY: this runs on the replay-safe journey hot path, so it must NEVER reject
 * into or alter journey execution / replay-safety. Any failure — a synchronous
 * build/dispatch throw OR a rejected insert — is swallowed to a silent no-op. It
 * returns `void`; callers must NOT `await` it in a way that could throw, and no
 * existing side effect may be reordered or gated on it.
 *
 * REPLAY: a journey is a Hatchet durable task that replays-from-top on eviction,
 * so a replay RE-LOGS (duplicate rows). That is acceptable for a timeline — the
 * Phase-3 reach-counts use `count(DISTINCT journey_state_id)` per `to_node_id`.
 * Do NOT attempt to dedupe log rows.
 */
export function logTransition(args: LogTransitionArgs): void {
  try {
    void args.db
      .insert(journeyLogs)
      .values({
        journeyStateId: args.journeyStateId,
        fromNodeId: args.from ?? null,
        toNodeId: args.to ?? null,
        action: args.action,
        detail: args.detail ?? null,
      })
      .catch(() => {
        // best-effort timeline write — never surface into journey execution
      });
  } catch {
    // synchronous build/dispatch failure — swallow; logging must never throw
  }
}
