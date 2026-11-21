/**
 * Thrown by `JourneyTest.run()` when the `until` horizon is reached while the
 * journey is still waiting. The run is not broken: it would resume after the
 * horizon. `simulateJourney` reports it as `running`.
 */
export class JourneyHorizonError extends Error {
  override readonly name = "JourneyHorizonError";

  constructor(
    /** The virtual instant the run was stopped at (ISO). */
    readonly at: string,
  ) {
    super(`journey still running at the horizon (${at})`);
  }
}

/**
 * Thrown when a run records more than `maxTimelineEntries` timeline entries,
 * which usually means the journey loops without a wait.
 */
export class JourneyStepBudgetError extends Error {
  override readonly name = "JourneyStepBudgetError";

  constructor(
    readonly limit: number,
    /** The virtual instant the budget ran out at (ISO). */
    readonly at: string,
  ) {
    super(
      `journey recorded more than ${limit} timeline entries (stopped at ${at}); it may loop without waiting`,
    );
  }
}
