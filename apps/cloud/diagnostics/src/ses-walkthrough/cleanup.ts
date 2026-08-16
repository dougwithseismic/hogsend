/**
 * The teardown stack: everything the walkthrough created, undone in reverse.
 *
 * Three rules, each of which exists because the alternative leaves billable
 * AWS resources behind:
 *
 *  - **Registered at creation time, not listed up front.** A step is pushed the
 *    moment its resource exists, so a run that dies halfway tears down exactly
 *    what it made and nothing it did not. A hand-written teardown list drifts
 *    from the creation order the first time a step is inserted.
 *  - **Reverse order.** Dependents come down before the things they depend on,
 *    for free, because that is the order they were built in.
 *  - **A throwing step does not stop the run.** It is RECORDED and the stack
 *    keeps going: the alternative is one stuck resource stranding every
 *    resource under it. The report names what could not be removed, which is
 *    what the operator needs in order to sweep it by hand.
 */

export interface CleanupFailure {
  label: string;
  error: string;
}

export interface CleanupReport {
  /** Labels in EXECUTION order — reverse of registration. Includes failures. */
  order: string[];
  failed: CleanupFailure[];
}

export class CleanupStack {
  private readonly steps: { label: string; undo: () => Promise<void> }[] = [];

  push(label: string, undo: () => Promise<void>): void {
    this.steps.push({ label, undo });
  }

  get size(): number {
    return this.steps.length;
  }

  /** Never throws. A teardown that can fail the run has no way to report. */
  async run(): Promise<CleanupReport> {
    const order: string[] = [];
    const failed: CleanupFailure[] = [];

    for (let index = this.steps.length - 1; index >= 0; index -= 1) {
      const step = this.steps[index];
      if (!step) continue;
      order.push(step.label);
      try {
        await step.undo();
      } catch (error) {
        failed.push({
          label: step.label,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    return { order, failed };
  }
}
