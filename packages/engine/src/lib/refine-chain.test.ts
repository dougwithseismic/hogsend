import assert from "node:assert/strict";
import test from "node:test";
import type { EnrichmentProvider, EnrichmentResult } from "@hogsend/core";
import {
  type JourneyBoundary,
  runWithJourneyBoundary,
} from "../journeys/journey-boundary.js";
import {
  type RefineChainDeps,
  type RefineContactOptions,
  type RefineContactResult,
  runRefineChain,
} from "./refine-chain.js";

// ---------------------------------------------------------------------------
// Harness — a boundary that RECORDS every durable call, and a fake provider
// with a call COUNTER. AC 11 cannot be proved by return values alone: the
// positional-journal law is about which durable calls were issued, in which
// order, so that is what the stub records.
// ---------------------------------------------------------------------------

const NOW = new Date("2026-07-25T12:00:00.000Z");
const FOUND: EnrichmentResult = {
  found: true,
  person: { title: "CTO", seniority: "c_suite" },
  company: { name: "Acme", employeeCount: 250 },
  raw: { ok: true },
};

interface RecordingBoundary {
  boundary: JourneyBoundary;
  /** One entry per durable call, in issuance order. */
  durableCalls: string[];
}

function recordingBoundary(
  currentLabel?: string,
  memoStrategy: "run" | "skip" = "run",
): RecordingBoundary {
  const durableCalls: string[] = [];
  const boundary: JourneyBoundary = {
    stateId: "state-1",
    runAnchor: "run-1",
    currentLabel,
    seenKeys: new Set(),
    seenRecordLabels: new Set(),
    memoize: async (deps, fn) => {
      durableCalls.push(`memoize:${JSON.stringify(deps)}`);
      // "skip" models an eviction-capable engine replaying a recorded value
      // WITHOUT re-entering the closure.
      if (memoStrategy === "skip") {
        return { status: "cached" } as unknown as never;
      }
      return fn();
    },
  };
  return { boundary, durableCalls };
}

interface FakeProvider {
  provider: EnrichmentProvider;
  calls: () => number;
}

function fakeProvider(behaviour: "found" | "throw" = "found"): FakeProvider {
  let calls = 0;
  const provider: EnrichmentProvider = {
    meta: { id: "fake", name: "Fake" },
    capabilities: { personLookup: true, companyLookup: true },
    enrichPerson: async () => {
      calls += 1;
      if (behaviour === "throw") throw new Error("vendor 503");
      return FOUND;
    },
  };
  return { provider, calls: () => calls };
}

interface Harness {
  deps: RefineChainDeps;
  providerCalls: () => number;
  ledgerWrites: number;
  ingests: number;
}

function harness(overrides: {
  provider?: EnrichmentProvider;
  providerCalls?: () => number;
  ledgerRow?: { status: "found" | "not_found" | "error"; expiresAt: Date };
  monthlyCap?: number;
  usedThisMonth?: number;
  domainOnly?: boolean;
}): Harness {
  const fake = fakeProvider();
  const provider = overrides.provider ?? fake.provider;
  const providerCalls = overrides.providerCalls ?? fake.calls;
  const state = { ledgerWrites: 0, ingests: 0 };

  const deps: RefineChainDeps = {
    provider,
    providerId: provider.meta.id,
    ttlDays: 90,
    monthlyCap: overrides.monthlyCap ?? 0,
    now: () => NOW,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    budgetWindowStart: () => new Date("2026-07-01T00:00:00.000Z"),
    resolveTarget: async () =>
      overrides.domainOnly
        ? { contactId: "c1", userId: "u1", domain: "acme.com" }
        : {
            contactId: "c1",
            userId: "u1",
            email: "a@acme.com",
            refinedProperties: { refined_title: "old" },
          },
    findLedgerRow: async () => overrides.ledgerRow ?? null,
    countLookupsSince: async () => overrides.usedThisMonth ?? 0,
    writeLedgerRow: async () => {
      state.ledgerWrites += 1;
    },
    ingest: async () => {
      state.ingests += 1;
    },
  };

  return {
    deps,
    providerCalls,
    get ledgerWrites() {
      return state.ledgerWrites;
    },
    get ingests() {
      return state.ingests;
    },
  };
}

const unexpired = (status: "found" | "not_found" | "error") => ({
  status,
  expiresAt: new Date(NOW.getTime() + 86_400_000),
});

async function runInBoundary(
  deps: RefineChainDeps,
  opts: RefineContactOptions = {},
  boundaryArgs: Parameters<typeof recordingBoundary> = [],
): Promise<{ result: RefineContactResult; durableCalls: string[] }> {
  const { boundary, durableCalls } = recordingBoundary(...boundaryArgs);
  const result = await runWithJourneyBoundary(boundary, () =>
    runRefineChain(deps, opts),
  );
  return { result, durableCalls };
}

// ---------------------------------------------------------------------------
// AC 11 — THE POSITIONAL-JOURNAL LAW
// ---------------------------------------------------------------------------

test("AC 11: memoize is issued EXACTLY ONCE per invocation, identically, no matter which gate returns", async () => {
  // Three chains that return from three DIFFERENT gates. Refinement is the worst
  // case for the law because the ledger gate (cached) reads the very row the
  // `refined` path writes at its final step — so a naive "check ledger, early
  // return, then memoize" would diverge on EVERY replay, not occasionally.
  const cached = await runInBoundary(
    harness({ ledgerRow: unexpired("found") }).deps,
  );
  const budget = await runInBoundary(
    harness({ monthlyCap: 5, usedThisMonth: 5 }).deps,
  );
  const refined = await runInBoundary(harness({}).deps);
  const notFoundCached = await runInBoundary(
    harness({ ledgerRow: unexpired("not_found") }).deps,
  );
  const providerError = await runInBoundary(
    harness({ provider: fakeProvider("throw").provider }).deps,
  );

  // The verdicts genuinely differ...
  assert.equal(cached.result.status, "cached");
  assert.deepEqual(budget.result, {
    status: "skipped",
    reason: "budget_exceeded",
  });
  assert.equal(refined.result.status, "refined");
  assert.equal(notFoundCached.result.status, "not_found");
  assert.deepEqual(providerError.result, {
    status: "skipped",
    reason: "provider_error",
  });

  // ...and yet the durable journal is byte-identical across all five.
  const expected = ['memoize:["journeyRefine:run-1:a@acme.com:a@acme.com"]'];
  assert.deepEqual(cached.durableCalls, expected);
  assert.deepEqual(budget.durableCalls, expected);
  assert.deepEqual(refined.durableCalls, expected);
  assert.deepEqual(notFoundCached.durableCalls, expected);
  assert.deepEqual(providerError.durableCalls, expected);
});

test("AC 11: the memo key is derived from the nearest wait label, and idempotencyLabel wins", async () => {
  const labelled = await runInBoundary(harness({}).deps, {}, ["wait:nps"]);
  assert.deepEqual(labelled.durableCalls, [
    'memoize:["journeyRefine:run-1:wait:nps:a@acme.com"]',
  ]);

  const explicit = await runInBoundary(harness({}).deps, {
    idempotencyLabel: "second-pass",
  });
  assert.deepEqual(explicit.durableCalls, [
    'memoize:["journeyRefine:run-1:second-pass:a@acme.com"]',
  ]);
});

test("AC 11: an eviction-capable engine replays the RECORDED verdict without re-entering the closure", async () => {
  // `memoStrategy: "skip"` models a live-eviction Hatchet: the closure is never
  // run on the replay, so no gate, no provider call, no ledger write, no ingest.
  const h = harness({});
  const { boundary, durableCalls } = recordingBoundary(undefined, "skip");
  const result = await runWithJourneyBoundary(boundary, () =>
    runRefineChain(h.deps, {}),
  );

  assert.deepEqual(result, { status: "cached" });
  assert.equal(h.providerCalls(), 0);
  assert.equal(h.ledgerWrites, 0);
  assert.equal(h.ingests, 0);
  assert.deepEqual(durableCalls, [
    'memoize:["journeyRefine:run-1:a@acme.com:a@acme.com"]',
  ]);
});

test("two refine sites under one wait label collide loudly instead of silently over-deduping", async () => {
  const h = harness({});
  const { boundary } = recordingBoundary("wait:same");

  await runWithJourneyBoundary(boundary, async () => {
    await runRefineChain(h.deps, {});
    await assert.rejects(
      runRefineChain(h.deps, {}),
      /duplicate idempotency key/,
    );
  });
});

// ---------------------------------------------------------------------------
// Gate-ordering behaviour that needs no database
// ---------------------------------------------------------------------------

test("with NO boundary the chain runs directly — zero durable calls, Layer 2 carries it", async () => {
  const h = harness({});
  const result = await runRefineChain(h.deps, {});

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
  assert.equal(h.ledgerWrites, 1);
  assert.equal(h.ingests, 1);
});

test("step 1: no resolvable lookup key skips with zero spend and no durable call", async () => {
  const h = harness({});
  h.deps.resolveTarget = async () => null;
  const { result, durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(result, { status: "skipped", reason: "no_lookup_key" });
  assert.equal(h.providerCalls(), 0);
  // Step 1 is a pure/config read that cannot change between a run and its
  // replay, so early-returning BEFORE the memoize is the safe case.
  assert.deepEqual(durableCalls, []);
});

test("AC 6: no active provider skips with zero spend and never throws", async () => {
  const h = harness({});
  h.deps.provider = undefined;
  h.deps.providerId = undefined;
  const { result, durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(result, { status: "skipped", reason: "no_provider" });
  assert.equal(h.providerCalls(), 0);
  assert.deepEqual(durableCalls, []);
});

test("an unexpired `error` ledger row does NOT short-circuit — the vendor is retried", async () => {
  const h = harness({ ledgerRow: unexpired("error") });
  const result = await runRefineChain(h.deps, {});

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
});

test("an EXPIRED found row does not short-circuit", async () => {
  const h = harness({
    ledgerRow: {
      status: "found",
      expiresAt: new Date(NOW.getTime() - 1_000),
    },
  });
  const result = await runRefineChain(h.deps, {});

  assert.equal(result.status, "refined");
  assert.equal(h.providerCalls(), 1);
});

test("force bypasses the ledger gate but NOT the budget cap", async () => {
  const bypass = harness({ ledgerRow: unexpired("found") });
  assert.equal(
    (await runRefineChain(bypass.deps, { force: true })).status,
    "refined",
  );
  assert.equal(bypass.providerCalls(), 1);

  const capped = harness({
    ledgerRow: unexpired("found"),
    monthlyCap: 2,
    usedThisMonth: 2,
  });
  assert.deepEqual(await runRefineChain(capped.deps, { force: true }), {
    status: "skipped",
    reason: "budget_exceeded",
  });
  assert.equal(capped.providerCalls(), 0);
});

test("a domain-only contact looks up by domain kind", async () => {
  const h = harness({ domainOnly: true });
  const { durableCalls } = await runInBoundary(h.deps);

  assert.deepEqual(durableCalls, [
    'memoize:["journeyRefine:run-1:acme.com:acme.com"]',
  ]);
  assert.equal(h.providerCalls(), 1);
});
