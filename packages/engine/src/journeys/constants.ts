/**
 * Max active execution time configured on every journey durable task
 * (`executionTimeout`). It is the single source of truth shared by
 * `define-journey` (the task config) and `journey-context` (the `waitForEvent`
 * timeout ceiling) so the two never drift.
 *
 * NOTE: on eviction-capable Hatchet engines (>= v0.80.0) a durable wait evicts
 * the task and frees the worker slot, so a very long wall-clock wait MAY exceed
 * this. We still treat it as our ceiling: `waitForEvent` rejects timeouts beyond
 * it so they fail fast at authoring time rather than risk a mid-wait
 * termination. Raise this to allow longer waits.
 */
export const JOURNEY_EXECUTION_TIMEOUT_HOURS = 720;
export const JOURNEY_EXECUTION_TIMEOUT = `${JOURNEY_EXECUTION_TIMEOUT_HOURS}h`;

/**
 * Max time a journey task may wait in the queue for a worker slot before Hatchet
 * cancels it (`scheduleTimeout`). The SDK default (~5m) is too tight for a
 * durable-wait RESUME that re-queues during a redeploy when every worker slot is
 * momentarily saturated — the resume would be cancelled and the enrollment
 * stranded. 15m gives resumes head-room to land on a freed slot.
 */
export const JOURNEY_SCHEDULE_TIMEOUT = "15m";
