import assert from "node:assert/strict";
import {
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "./journey-boundary.js";

/**
 * Test support for the positional-journal law — NOT part of the engine's
 * public surface, and imported only by `*.test.ts` files.
 *
 * The technique here is the extraction of `refine-chain.test.ts`'s AC 11
 * test, which was the ONLY reason defect 4 of the positional-journal class
 * (a skip path issuing ZERO durable calls, with a test asserting that as
 * correct) was catchable at all. Return values cannot prove the law — it is
 * about WHICH durable calls were issued, in WHICH order — so the harness
 * records exactly that and nothing else.
 */

export interface RecordingBoundary {
  boundary: JourneyBoundary;
  /** One entry per durable call, in issuance order. */
  durableCalls: string[];
}

export interface RecordingBoundaryOptions {
  /** The nearest authored wait label, as `ctx.sleep`/`waitForEvent` would set. */
  currentLabel?: string;
  /**
   * "run" (default) enters the memo closure, as a first run does. "skip"
   * models an eviction-capable engine REPLAYING a recorded value without
   * re-entering the closure — the memoize is journalled, the closure never
   * runs, and {@link RecordingBoundaryOptions.recordedValue} is returned.
   */
  memoStrategy?: "run" | "skip";
  /** What a "skip" memoize resolves to (the recorded verdict). */
  recordedValue?: unknown;
  runAnchor?: string;
  stateId?: string;
}

/**
 * A stub journey boundary that RECORDS every durable call it is issued.
 * Each recorded entry is `memoize:<JSON of the deps array>` — the same
 * byte-comparable shape `refine-chain.test.ts` established.
 */
export function createRecordingBoundary(
  opts: RecordingBoundaryOptions = {},
): RecordingBoundary {
  const durableCalls: string[] = [];
  const boundary: JourneyBoundary = {
    stateId: opts.stateId ?? "state-1",
    runAnchor: opts.runAnchor ?? "run-1",
    currentLabel: opts.currentLabel,
    seenKeys: new Set(),
    seenRecordLabels: new Set(),
    memoize: async (deps, fn) => {
      durableCalls.push(`memoize:${JSON.stringify(deps)}`);
      if (opts.memoStrategy === "skip") {
        return opts.recordedValue as never;
      }
      return fn();
    },
  };
  return { boundary, durableCalls };
}

export interface UniformJournalOptions<T> {
  /**
   * The return paths to drive, by name. Each runs inside its OWN fresh
   * recording boundary; the name is what a failure message points at.
   */
  paths: Record<string, () => Promise<T>>;
  /**
   * The exact journal every path must issue. Optional — when omitted, every
   * path is asserted byte-identical to the FIRST path's journal, which must
   * then be NON-empty: an all-paths-empty journal is exactly the shape of
   * defect 4 (zero durable calls asserted as correct), so asserting emptiness
   * requires spelling it out here explicitly.
   */
  expectedJournal?: string[];
  /** Applied to every path's boundary. */
  boundary?: Omit<RecordingBoundaryOptions, "memoStrategy" | "recordedValue">;
}

/**
 * THE LAW, as a reusable assertion: drive a durable function through N
 * different return paths and require the durable-call journal to be
 * byte-identical across every one of them.
 *
 * The Hatchet journal is positional. If ANY return path of a durable helper
 * issues a different sequence of durable calls than any other, then a replay
 * whose live state selects a different path shifts every later durable call
 * — the run is killed with a non-determinism error at best, and double-spends
 * at worst. Verdicts may differ; journals may not.
 *
 * Returns each path's result (keyed by path name) so the caller can go on to
 * assert the verdicts genuinely differ, plus the reference journal.
 */
export async function assertUniformDurableJournal<T>(
  opts: UniformJournalOptions<T>,
): Promise<{ results: Record<string, T>; journal: string[] }> {
  const names = Object.keys(opts.paths);
  assert.ok(names.length > 0, "assertUniformDurableJournal: no paths given");

  const results: Record<string, T> = {};
  const journals: Record<string, string[]> = {};

  for (const name of names) {
    const { boundary, durableCalls } = createRecordingBoundary(opts.boundary);
    const path = opts.paths[name];
    assert.ok(path, `assertUniformDurableJournal: path "${name}" missing`);
    results[name] = await runWithJourneyBoundary(boundary, path);
    journals[name] = durableCalls;
  }

  const first = names[0] as string;
  const reference = opts.expectedJournal ?? (journals[first] as string[]);
  if (opts.expectedJournal === undefined) {
    assert.ok(
      reference.length > 0,
      `durable journal for path "${first}" is EMPTY — a durable helper inside ` +
        "a boundary that issues zero durable calls is defect 4 of the " +
        "positional-journal class. If an empty journal is genuinely intended, " +
        "pass `expectedJournal: []` explicitly.",
    );
  }

  for (const name of names) {
    assert.deepEqual(
      journals[name],
      reference,
      `durable journal for path "${name}" diverged — the positional-journal ` +
        "law requires EVERY return path to issue a byte-identical sequence " +
        "of durable calls",
    );
  }

  return { results, journal: reference };
}
