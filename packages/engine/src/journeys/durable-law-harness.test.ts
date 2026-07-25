import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniformDurableJournal,
  createRecordingBoundary,
} from "./durable-law-harness.js";
import { getJourneyBoundary } from "./journey-boundary.js";

// A hand-rolled durable helper standing in for any future one: `broken`
// re-creates defect 4 exactly — one path early-returns BEFORE the memoize.
async function helper(opts: {
  skip: boolean;
  broken?: boolean;
}): Promise<string> {
  const boundary = getJourneyBoundary();
  if (!boundary) return opts.skip ? "skipped" : "done";
  if (opts.broken && opts.skip) return "skipped"; // defect 4: zero durable calls
  return boundary.memoize(["key-1"], async () =>
    opts.skip ? "skipped" : "done",
  );
}

test("the harness passes a helper whose journal is identical across paths, and returns each verdict", async () => {
  const { results, journal } = await assertUniformDurableJournal({
    paths: {
      skip: () => helper({ skip: true }),
      done: () => helper({ skip: false }),
    },
  });

  assert.deepEqual(journal, ['memoize:["key-1"]']);
  assert.equal(results.skip, "skipped");
  assert.equal(results.done, "done");
});

test("the harness FAILS a helper with one path issuing zero durable calls — defect 4's exact shape", async () => {
  await assert.rejects(
    assertUniformDurableJournal({
      paths: {
        done: () => helper({ skip: false, broken: true }),
        skip: () => helper({ skip: true, broken: true }),
      },
    }),
    /durable journal for path "skip" diverged/,
  );
});

test("the harness FAILS a helper whose paths issue DIFFERENT durable calls", async () => {
  await assert.rejects(
    assertUniformDurableJournal({
      expectedJournal: ['memoize:["key-1"]'],
      paths: {
        other: async () => {
          const boundary = getJourneyBoundary();
          assert.ok(boundary);
          return boundary.memoize(["key-2"], async () => "done");
        },
      },
    }),
    /durable journal for path "other" diverged/,
  );
});

test("an all-paths-empty journal never passes silently — asserting emptiness must be explicit", async () => {
  // Implicit reference journal + zero durable calls anywhere = the shape a
  // test asserted as CORRECT for defect 4. The harness refuses to bless it...
  await assert.rejects(
    assertUniformDurableJournal({
      paths: { a: async () => "x", b: async () => "y" },
    }),
    /is EMPTY/,
  );

  // ...unless the author spells the emptiness out.
  const { journal } = await assertUniformDurableJournal({
    expectedJournal: [],
    paths: { a: async () => "x" },
  });
  assert.deepEqual(journal, []);
});

test("each path runs in its OWN fresh boundary — journals never bleed across paths", async () => {
  const { journal } = await assertUniformDurableJournal({
    paths: {
      first: () => helper({ skip: false }),
      second: () => helper({ skip: false }),
    },
  });
  // Two paths, one memoize EACH — not two accumulated in one journal.
  assert.deepEqual(journal, ['memoize:["key-1"]']);
});

test("createRecordingBoundary skip strategy journals the memoize but never enters the closure", async () => {
  const { boundary, durableCalls } = createRecordingBoundary({
    memoStrategy: "skip",
    recordedValue: "recorded",
  });
  let entered = 0;
  const result = await boundary.memoize(["key-1"], async () => {
    entered += 1;
    return "live";
  });

  assert.equal(result, "recorded");
  assert.equal(entered, 0);
  assert.deepEqual(durableCalls, ['memoize:["key-1"]']);
});
