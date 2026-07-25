import assert from "node:assert/strict";
import test from "node:test";
import {
  assertUniformDurableJournal,
  createRecordingBoundary,
} from "./durable-law-harness.js";
import { runWithJourneyBoundary } from "./journey-boundary.js";
import { callerRefFromArgs, withDurableGate } from "./with-durable-gate.js";

// The branded ref every test keys from — an "authored argument" by fiat.
const REF = callerRefFromArgs("u1");
assert.ok(REF);

// ---------------------------------------------------------------------------
// AC 1 — exactly ONE memoize per invocation, no matter which path gates()
// returns from
// ---------------------------------------------------------------------------

test("AC 1: memoize is issued exactly once, identically, for every return path of gates() — including an early return", async () => {
  const { results, journal } = await assertUniformDurableJournal({
    expectedJournal: ['memoize:["journeyRefine:run-1:u1:u1"]'],
    paths: {
      // The classic footgun: gates() returns from its FIRST line. The memoize
      // must still have been issued before gates() ever ran.
      earlyReturn: () =>
        withDurableGate({ kind: "refine", callerRef: REF }, async () => {
          return { status: "skipped", reason: "no_lookup_key" };
        }),
      midReturn: () =>
        withDurableGate({ kind: "refine", callerRef: REF }, async () => {
          await Promise.resolve();
          return { status: "cached" };
        }),
      fullRun: () =>
        withDurableGate({ kind: "refine", callerRef: REF }, async () => {
          await Promise.resolve();
          await Promise.resolve();
          return { status: "refined" };
        }),
    },
  });

  // The verdicts genuinely differ; the journal (asserted above) did not.
  assert.deepEqual(results.earlyReturn, {
    status: "skipped",
    reason: "no_lookup_key",
  });
  assert.deepEqual(results.midReturn, { status: "cached" });
  assert.deepEqual(results.fullRun, { status: "refined" });
  assert.deepEqual(journal, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("AC 1: gates() receives the derived key, to thread into Layer-2 writes", async () => {
  const { boundary } = createRecordingBoundary();
  let received: string | undefined = "sentinel";
  await runWithJourneyBoundary(boundary, () =>
    withDurableGate({ kind: "refine", callerRef: REF }, async (key) => {
      received = key;
      return null;
    }),
  );
  assert.equal(received, "journeyRefine:run-1:u1:u1");
});

test("AC 1: an eviction-capable engine replays the recorded verdict without re-entering gates()", async () => {
  const { boundary, durableCalls } = createRecordingBoundary({
    memoStrategy: "skip",
    recordedValue: { status: "cached" },
  });
  let entered = 0;
  const result = await runWithJourneyBoundary(boundary, () =>
    withDurableGate({ kind: "refine", callerRef: REF }, async () => {
      entered += 1;
      return { status: "refined" };
    }),
  );

  assert.deepEqual(result, { status: "cached" });
  assert.equal(entered, 0);
  assert.deepEqual(durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("two sites deriving one key collide loudly instead of silently over-deduping", async () => {
  const { boundary } = createRecordingBoundary({ currentLabel: "wait:same" });
  await runWithJourneyBoundary(boundary, async () => {
    await withDurableGate({ kind: "refine", callerRef: REF }, async () => 1);
    await assert.rejects(
      withDurableGate({ kind: "refine", callerRef: REF }, async () => 2),
      /duplicate idempotency key/,
    );
  });
});

// ---------------------------------------------------------------------------
// AC 2 — no boundary: gates() runs directly, zero durable calls
// ---------------------------------------------------------------------------

test("AC 2: with no boundary, gates() runs directly with no key and no durable calls", async () => {
  let received: string | undefined = "sentinel";
  let entered = 0;
  const result = await withDurableGate(
    { kind: "refine", callerRef: REF },
    async (key) => {
      entered += 1;
      received = key;
      return { status: "refined" };
    },
  );

  assert.deepEqual(result, { status: "refined" });
  assert.equal(entered, 1);
  // No boundary → no key: Layer 2's unique index carries exactly-once alone.
  assert.equal(received, undefined);
});

// ---------------------------------------------------------------------------
// AC 3 — key determinism
// ---------------------------------------------------------------------------

async function journalFor(opts: {
  callerRef: string;
  idempotencyLabel?: string;
  currentLabel?: string;
}): Promise<string[]> {
  const { boundary, durableCalls } = createRecordingBoundary({
    currentLabel: opts.currentLabel,
  });
  const ref = callerRefFromArgs(opts.callerRef);
  assert.ok(ref);
  await runWithJourneyBoundary(boundary, () =>
    withDurableGate(
      {
        kind: "refine",
        callerRef: ref,
        idempotencyLabel: opts.idempotencyLabel,
      },
      async () => null,
    ),
  );
  return durableCalls;
}

test("AC 3: same callerRef + same label derive the same key; either differing re-keys", async () => {
  // Identical inputs → identical key, across independent invocations.
  assert.deepEqual(
    await journalFor({ callerRef: "u1", idempotencyLabel: "second-pass" }),
    await journalFor({ callerRef: "u1", idempotencyLabel: "second-pass" }),
  );

  const base = await journalFor({ callerRef: "u1" });
  assert.deepEqual(base, ['memoize:["journeyRefine:run-1:u1:u1"]']);

  // A different callerRef re-keys...
  assert.notDeepEqual(await journalFor({ callerRef: "u2" }), base);
  // ...and a different label re-keys.
  assert.notDeepEqual(
    await journalFor({ callerRef: "u1", idempotencyLabel: "second-pass" }),
    base,
  );
});

test("AC 3: the site precedence is idempotencyLabel ?? nearest wait label ?? callerRef", async () => {
  assert.deepEqual(await journalFor({ callerRef: "u1" }), [
    'memoize:["journeyRefine:run-1:u1:u1"]',
  ]);
  assert.deepEqual(
    await journalFor({ callerRef: "u1", currentLabel: "wait:nps" }),
    ['memoize:["journeyRefine:run-1:wait:nps:u1"]'],
  );
  assert.deepEqual(
    await journalFor({
      callerRef: "u1",
      currentLabel: "wait:nps",
      idempotencyLabel: "second-pass",
    }),
    ['memoize:["journeyRefine:run-1:second-pass:u1"]'],
  );
});

test("AC 3: the kind namespaces the key, so two kinds under one label never collide", async () => {
  const { boundary, durableCalls } = createRecordingBoundary({
    currentLabel: "wait:same",
  });
  await runWithJourneyBoundary(boundary, async () => {
    await withDurableGate({ kind: "refine", callerRef: REF }, async () => 1);
    await withDurableGate({ kind: "connector", callerRef: REF }, async () => 2);
  });
  assert.deepEqual(durableCalls, [
    'memoize:["journeyRefine:run-1:wait:same:u1"]',
    'memoize:["journeyConnector:run-1:wait:same:u1"]',
  ]);
});

// ---------------------------------------------------------------------------
// AC 4 — a value not routed through callerRefFromArgs fails to TYPE-CHECK.
// These closures are never invoked; `check-types` is the assertion — if the
// forbidden call ever compiles, the @ts-expect-error itself becomes an error.
// ---------------------------------------------------------------------------

test("AC 4 (type-level): a bare string — e.g. a DB-read value — cannot be passed as callerRef", () => {
  const rejectsPlainString = (dbDerived: string) =>
    // @ts-expect-error — string is not assignable to CallerRef; route the
    // caller's OWN argument through callerRefFromArgs instead.
    withDurableGate({ kind: "refine", callerRef: dbDerived }, async () => null);

  const rejectsLiteral = () =>
    // @ts-expect-error — even a literal must go through the chokepoint.
    withDurableGate({ kind: "refine", callerRef: "u1" }, async () => null);

  const rejectsInterpolation = (row: { email: string }) =>
    withDurableGate(
      // @ts-expect-error — a template string over a resolved row is still a
      // plain string, not a CallerRef.
      { kind: "refine", callerRef: `${row.email}` },
      async () => null,
    );

  // The closures exist only to be type-checked.
  assert.equal(typeof rejectsPlainString, "function");
  assert.equal(typeof rejectsLiteral, "function");
  assert.equal(typeof rejectsInterpolation, "function");
});

test("AC 4: callerRefFromArgs trims, and refuses an empty value", () => {
  assert.equal(callerRefFromArgs("  c-9  "), "c-9");
  assert.equal(callerRefFromArgs("   "), undefined);
  assert.equal(callerRefFromArgs(""), undefined);
  assert.equal(callerRefFromArgs(undefined), undefined);
});

// ---------------------------------------------------------------------------
// AC 6 — a throw from gates() propagates, with no recorded verdict
// ---------------------------------------------------------------------------

test("AC 6: a throw from gates() propagates unswallowed, after the single memoize was issued", async () => {
  const { boundary, durableCalls } = createRecordingBoundary();
  await assert.rejects(
    runWithJourneyBoundary(boundary, () =>
      withDurableGate({ kind: "refine", callerRef: REF }, async () => {
        throw new Error("vendor 503");
      }),
    ),
    /vendor 503/,
  );
  // The journal still holds exactly the one memoize — the rejection rode
  // through it (Hatchet records no value for a rejected closure, so a replay
  // re-enters gates()).
  assert.deepEqual(durableCalls, ['memoize:["journeyRefine:run-1:u1:u1"]']);
});

test("AC 6: with no boundary a throw propagates too", async () => {
  await assert.rejects(
    withDurableGate({ kind: "refine", callerRef: REF }, async () => {
      throw new Error("vendor 503");
    }),
    /vendor 503/,
  );
});
