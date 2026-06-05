/**
 * Thrown by durable wait primitives (e.g. `ctx.waitForEvent`) when the journey
 * reached a terminal state — exited via `exitOn`, or cancelled — while it was
 * suspended. It is a CONTROL-FLOW SIGNAL, not a failure: `defineJourney` catches
 * it and stops the run gracefully WITHOUT marking the state `"failed"` (the row
 * is already terminal). Consumers generally never observe it; it simply aborts
 * `run()` before any post-wait side effect can fire.
 */
export class JourneyExitedError extends Error {
  readonly stateId: string;

  constructor(stateId: string) {
    super(`Journey state ${stateId} is no longer active (exited or cancelled)`);
    this.name = "JourneyExitedError";
    this.stateId = stateId;
  }
}
